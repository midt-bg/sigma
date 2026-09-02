// The touched sets (refresh_touched_contracts / _bidders / _authorities) must SURVIVE an aborted run.
//
// Why this exists: from 2026-08-14 to 09-02 every cron refresh on staging died at `derive-slice:amendments`
// (SQLITE_NOMEM, #342). Each of those runs had already committed `derive-slice:contracts` — new contracts
// AND the ids they touched — because every @refresh-batch is its own atomic D1 batch. The next run's
// `setup` then DROPped the touched tables and re-created them empty, and because the catch-up window
// after an abort is a three-day lookback, the entities of contracts inserted days earlier were never
// touched again. Rollups for 276 authorities and 481 bidders stopped summing to their contracts
// (−139 M€ / −200 M€) and rollup-reconciliation tripped on the first run that survived.
//
// Two layers: a static test on the SQL's shape (cheap, runs everywhere) and a behavioural test that runs
// the real refresh-slice.sql groups on SQLite — an aborted run 1, then a run 2 whose window stages NOTHING
// — and asserts run 2 still recomputes run 1's rollups. The behavioural test is the one that fails on the
// old shape; the static one says exactly which line drifted.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkRollupReconciliation,
  type IntegrityResult,
} from '../../../scripts/integrity-checks.mjs';
import {
  TOUCHED_SET_TABLES,
  dropTransientStagingStatements,
  refreshSliceStatementGroups,
} from './refresh';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = resolve(root, 'packages/db/migrations');
const workStagingSchema = resolve(root, 'scripts/work-staging-schema.sql');
const SQL = readFileSync(resolve(root, 'scripts/refresh-slice.sql'), 'utf8');
const GROUPS = refreshSliceStatementGroups(SQL);

const group = (name: string) => {
  const g = GROUPS.find((x) => x.name === name);
  if (!g) throw new Error(`refresh-slice.sql has no @refresh-batch ${name}`);
  return g;
};
const groupIndex = (name: string) => GROUPS.findIndex((x) => x.name === name);
const mentions = (statement: string, table: string) => statement.includes(table);
const lastIndexWhere = (items: string[], pred: (s: string) => boolean): number => {
  for (let i = items.length - 1; i >= 0; i -= 1) if (pred(items[i]!)) return i;
  return -1;
};

describe('touched sets — SQL shape', () => {
  it('setup creates the touched tables IF NOT EXISTS and never drops or clears them', () => {
    const setup = group('setup').statements;
    for (const table of TOUCHED_SET_TABLES) {
      expect(
        setup.filter((s) => /^\s*CREATE TABLE IF NOT EXISTS\b/i.test(s) && mentions(s, table)),
        `${table}: one CREATE TABLE IF NOT EXISTS in setup`,
      ).toHaveLength(1);
      expect(
        setup.filter(
          (s) =>
            /^\s*(DROP TABLE|DELETE FROM|CREATE TABLE(?! IF NOT EXISTS))\b/i.test(s) &&
            mentions(s, table),
        ),
        `${table}: setup must not drop, clear or re-create it — that throws away an aborted run's ids`,
      ).toEqual([]);
    }
  });

  it('only cleanup drops them, and cleanup runs after every reader', () => {
    const dropsIn = (name: string) =>
      group(name).statements.filter(
        (s) => /^\s*DROP TABLE\b/i.test(s) && TOUCHED_SET_TABLES.some((t) => mentions(s, t)),
      );
    expect(dropsIn('cleanup'), 'cleanup drops all three').toHaveLength(TOUCHED_SET_TABLES.length);
    for (const g of GROUPS) {
      if (g.name === 'cleanup') continue;
      expect(dropsIn(g.name), `${g.name} must not drop a touched table`).toEqual([]);
    }
    // Every batch that reads a touched set must precede cleanup — otherwise cleanup would run
    // between a writer and its reader. Derived from the SQL, not from a hand-kept list.
    const readers = GROUPS.filter(
      (g) =>
        g.name !== 'cleanup' &&
        g.statements.some((s) => TOUCHED_SET_TABLES.some((t) => mentions(s, t))),
    ).map((g) => g.name);
    expect(readers, 'the rollups read the touched sets').toEqual(
      expect.arrayContaining(['company-totals', 'authority-totals', 'contract-search-index']),
    );
    const cleanupAt = groupIndex('cleanup');
    for (const name of readers) {
      expect(groupIndex(name), `${name} runs before cleanup`).toBeLessThan(cleanupAt);
    }
  });

  it('the abort path (dropTransientStagingStatements) leaves them alone', () => {
    for (const statement of dropTransientStagingStatements()) {
      for (const table of TOUCHED_SET_TABLES) {
        expect(
          statement,
          'an abort must not discard the ids the aborted run touched',
        ).not.toContain(table);
      }
    }
  });

  it('every batch that changes contracts records the ids it touched — after its last change', () => {
    // The other half of durability. Surviving tables are worthless if the ids never reach them: until
    // 2026-09-02 the recording sat one batch AFTER the inserts, in `amendments`, and that is exactly the
    // batch that kept dying. Derived from the SQL, so a new batch that starts writing contracts without
    // recording them trips this the day it lands. Comments are stripped first, and the verb may open ANY
    // line of the statement — the final amendments re-valuation is `WITH … UPDATE contracts`, which a
    // statement-start match would miss.
    const code = (s: string) => s.replace(/--[^\n]*/g, '');
    const mutates = (s: string) =>
      /^\s*(INSERT(\s+OR\s+(REPLACE|IGNORE))?\s+INTO\s+contracts|UPDATE\s+contracts|DELETE\s+FROM\s+contracts)\b/im.test(
        code(s),
      );
    const records = (s: string) =>
      /^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+refresh_touched_contracts\b/im.test(code(s));
    const recordsCoAuthorities = (s: string) =>
      /INSERT\s+OR\s+IGNORE\s+INTO\s+refresh_touched_authorities[\s\S]*FROM\s+contract_co_authorities\b/i.test(
        code(s),
      );
    const mutating = GROUPS.filter((g) => g.statements.some(mutates)).map((g) => g.name);
    expect(mutating, 'the batches that write contracts').toEqual(
      expect.arrayContaining(['contracts', 'amendments']),
    );
    for (const name of mutating) {
      const statements = group(name).statements;
      const lastMutation = lastIndexWhere(statements, mutates);
      const lastRecord = lastIndexWhere(statements, records);
      expect(lastRecord, `${name} must record the contracts it touched`).toBeGreaterThan(-1);
      expect(
        lastRecord,
        `${name}: the recording must come AFTER the last statement that changes contracts, in the same batch`,
      ).toBeGreaterThan(lastMutation);
      // Joint procurement: a changed contract changes every co-authority's joint rollup, not only the
      // lead's — the batch must fan its touched contracts out through contract_co_authorities too.
      expect(
        lastIndexWhere(statements, recordsCoAuthorities),
        `${name}: must touch the co-authorities of the contracts it changed, after its last change`,
      ).toBeGreaterThan(lastMutation);
    }
  });

  it('the batches that write entity metadata record the entities in the same batch', () => {
    // authorities-bidders upserts names/ownership, enrich-* write settlement/nuts/contacts — all of
    // which land in the rollup rows and the search index. Each must record what it touched itself,
    // not rely on `touch-entities` two batches later, or an abort in between loses the record.
    const touchesAuthorities = (s: string) =>
      /^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+refresh_touched_authorities\b/im.test(s);
    const touchesBidders = (s: string) =>
      /^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+refresh_touched_bidders\b/im.test(s);
    const writesAuthorities = (s: string) =>
      /^\s*(UPDATE\s+authorities|INSERT(\s+OR\s+\w+)?\s+INTO\s+authorities)\b/im.test(s);
    const writesBidders = (s: string) =>
      /^\s*(UPDATE\s+bidders|INSERT(\s+OR\s+\w+)?\s+INTO\s+bidders)\b/im.test(s);
    const seen: string[] = [];
    for (const g of GROUPS) {
      // authority-region derives from nuts for ids that are ALREADY touched; it writes nothing new.
      if (g.name === 'authority-region') continue;
      const st = g.statements;
      if (st.some(writesAuthorities)) {
        seen.push(`${g.name}:authorities`);
        expect(
          lastIndexWhere(st, touchesAuthorities),
          `${g.name} writes authorities → must record them in the same batch, after the write`,
        ).toBeGreaterThan(lastIndexWhere(st, writesAuthorities));
      }
      if (st.some(writesBidders)) {
        seen.push(`${g.name}:bidders`);
        expect(
          lastIndexWhere(st, touchesBidders),
          `${g.name} writes bidders → must record them in the same batch, after the write`,
        ).toBeGreaterThan(lastIndexWhere(st, writesBidders));
      }
    }
    // Two writers in authorities-bidders that the window-ЕИК recorder cannot see: the global
    // type_group fill (touches out-of-window rows — recorded by its own predicate BEFORE it runs, when
    // the predicate still identifies them) and the split joint-procurement members (their ЕИК lives
    // inside a composite raw value — recorded from the members table itself).
    const ab = group('authorities-bidders').statements;
    const fill = ab.findIndex((s) => /^\s*UPDATE\s+authorities\s+SET\s+type_group\b/im.test(s));
    expect(fill, 'the type_group fill is still in authorities-bidders').toBeGreaterThan(-1);
    expect(
      ab
        .slice(0, fill)
        .some((s) => touchesAuthorities(s) && /WHERE\s+type_group\s+IS\s+NULL/i.test(s)),
      'the rows the global type_group fill is about to change are recorded before it',
    ).toBe(true);
    expect(
      ab.some((s) => touchesAuthorities(s) && /FROM\s+refresh_joint_authority_members\b/i.test(s)),
      'split joint-procurement members are recorded in authorities-bidders',
    ).toBe(true);
    // Not vacuous: the writers this was written for are really matched.
    expect(seen).toEqual(
      expect.arrayContaining([
        'authorities-bidders:authorities',
        'authorities-bidders:bidders',
        'enrich-authorities:authorities',
        'enrich-bidders:bidders',
      ]),
    );
  });

  it('TOUCHED_SET_TABLES names exactly the tables the SQL creates', () => {
    const created = group('setup')
      .statements.map((s) => /CREATE TABLE IF NOT EXISTS (refresh_touched_[a-z_]+)/i.exec(s)?.[1])
      .filter((x): x is string => Boolean(x))
      .sort();
    expect(created).toEqual([...TOUCHED_SET_TABLES].sort());
  });
});

// ── behavioural: real SQL on SQLite ─────────────────────────────────────────────────────────────────
function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], {
    input: `PRAGMA foreign_keys=ON;\n.read ${path}\n`,
    stdio: 'pipe',
  });
}
function exec(dbPath: string, sql: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: sql, encoding: 'utf8', stdio: 'pipe' });
}
function rows<T = Record<string, string | number | null>>(dbPath: string, sql: string): T[] {
  const out = execFileSync('sqlite3', ['-json', dbPath], { input: sql, encoding: 'utf8' }).trim();
  return out ? (JSON.parse(out) as T[]) : [];
}
// One D1 batch = one transaction, exactly as runRefreshSliceStatementGroup / the SQLite D1 facade do.
function runGroups(dbPath: string, names: string[]): void {
  for (const name of names) exec(dbPath, `BEGIN;\n${group(name).statements.join(';\n')};\nCOMMIT;`);
}
function tableExists(dbPath: string, table: string): boolean {
  return (
    rows<{ n: number }>(
      dbPath,
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='${table}'`,
    )[0]!.n === 1
  );
}

const UNP = 'UNP-ABORT-1';
const AUTHORITY_EIK = '123456786';
const CONTRACTOR_EIK = '987654321';
const SIGNING_BGN = 195583; // exactly 100 000 EUR at the peg, so the rollup sum is an easy number
const BGN_PEG = 1.95583;

function seedWindow(dbPath: string): void {
  exec(
    dbPath,
    `INSERT INTO raw_tenders
      (source, dataset_year, fetched_at, unp, tender_id, procedure_type, procurement_subject,
       cpv_code, cpv_description, contract_kind, estimated_value, currency, authority_name,
       authority_eik, authority_type, published_at)
     VALUES
      ('eop:tenders:2026-06-01', 2026, '2026-06-07T00:00:00Z', '${UNP}', 'T-${UNP}', 'open',
       'Subject ${UNP}', '45000000', 'Construction', 'works', 5000, 'BGN', 'Authority ${UNP}',
       '${AUTHORITY_EIK}', 'public', '2026-06-01');
     INSERT INTO raw_contracts
      (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
       published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
       cpv_description, contract_kind, estimated_value, procurement_currency, authority_name,
       authority_eik, authority_type, contract_number, contract_date, signing_value, currency,
       contract_subject, awarded_to_group, contractor_eik, contractor_name)
     VALUES
      ('eop:contracts:2026-06-01', 2026, 'eop', '2026-06-07T00:00:00Z', 0, 'DOC-Д-1',
       '2026-06-01', '${UNP}', 'T-${UNP}', 'open', 'Subject ${UNP}', '45000000', 'Construction',
       'works', 5000, 'BGN', 'Authority ${UNP}', '${AUTHORITY_EIK}', 'public', 'Д-1',
       '2026-06-02', ${SIGNING_BGN}, 'BGN', 'Contract Д-1', 0, '${CONTRACTOR_EIK}', 'Bidder ${UNP}');`,
  );
}

describe('touched sets — an aborted run is finished by the next one', () => {
  let dir: string;
  let db: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'touched-durability-'));
    db = resolve(dir, 'served.sqlite');
    for (const file of readdirSync(migrationsDir).sort()) {
      if (file.endsWith('.sql')) readScript(db, resolve(migrationsDir, file));
    }
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('run 2 with an EMPTY window recomputes the rollups of the contract run 1 inserted before dying', () => {
    // ── run 1: stage one contract, derive up to and including `contracts`, then die (as at `amendments`).
    readScript(db, workStagingSchema);
    seedWindow(db);
    const upToContracts = GROUPS.slice(0, groupIndex('contracts') + 1).map((g) => g.name);
    expect(upToContracts.at(-1)).toBe('contracts');
    runGroups(db, upToContracts);
    // The abort path: the Workflow's finally drops the transient staging — and nothing else.
    exec(db, dropTransientStagingStatements().join(';\n') + ';');

    const inserted = rows<{ id: string; amount_eur: number }>(
      db,
      'SELECT id, amount_eur FROM contracts',
    );
    expect(inserted, 'run 1 committed the contract before dying').toHaveLength(1);
    expect(inserted[0]!.amount_eur).toBeCloseTo(SIGNING_BGN / BGN_PEG, 2);
    expect(rows(db, 'SELECT * FROM authority_totals'), 'rollups never ran in run 1').toEqual([]);
    for (const table of TOUCHED_SET_TABLES) {
      expect(tableExists(db, table), `${table} survives the abort`).toBe(true);
    }
    expect(rows(db, 'SELECT id FROM refresh_touched_contracts')).toEqual([{ id: inserted[0]!.id }]);

    // A carried-over authority with NO NUTS code has nothing to derive a region from — the batch must
    // leave whatever it has alone (a rebuild would not touch it either), not null it.
    exec(db, "UPDATE authorities SET region = 'Област Тест', nuts = NULL;");

    // ── run 2: a fresh, EMPTY staging window (nothing new to stage), the whole derive.
    readScript(db, workStagingSchema);
    runGroups(
      db,
      GROUPS.map((g) => g.name),
    );

    expect(
      rows(db, 'SELECT region FROM authorities'),
      'no NUTS code → the region is left alone for a carried id',
    ).toEqual([{ region: 'Област Тест' }]);
    const auth = rows<{ spent_eur: number; contracts: number }>(
      db,
      'SELECT spent_eur, contracts FROM authority_totals',
    );
    expect(auth, 'run 2 rolled up the authority run 1 touched').toHaveLength(1);
    expect(auth[0]!.contracts).toBe(1);
    expect(auth[0]!.spent_eur).toBeCloseTo(SIGNING_BGN / BGN_PEG, 2);
    const company = rows<{ won_eur: number; contracts: number }>(
      db,
      'SELECT won_eur, contracts FROM company_totals',
    );
    expect(company, 'and the bidder').toHaveLength(1);
    expect(company[0]!.won_eur).toBeCloseTo(SIGNING_BGN / BGN_PEG, 2);
    for (const table of TOUCHED_SET_TABLES) {
      expect(tableExists(db, table), `${table} is dropped by cleanup after a completed run`).toBe(
        false,
      );
    }
  });

  it('after run 2 the served gate reconciles (the check that fired on staging on 2026-09-02)', async () => {
    readScript(db, workStagingSchema);
    seedWindow(db);
    runGroups(
      db,
      GROUPS.slice(0, groupIndex('contracts') + 1).map((g) => g.name),
    );
    exec(db, dropTransientStagingStatements().join(';\n') + ';');
    // A carried id whose NUTS code has no mapping converges with a full rebuild: region becomes NULL
    // there (normalize-raw.sql derives it only from the lookup), so it must become NULL here too — an
    // old label must not survive a code it no longer describes.
    exec(db, "UPDATE authorities SET region = 'Стара област', nuts = 'ZZ999';");
    readScript(db, workStagingSchema);
    runGroups(
      db,
      GROUPS.map((g) => g.name),
    );
    expect(
      rows(db, 'SELECT region FROM authorities'),
      'an unmapped NUTS code yields NULL, exactly as the full path',
    ).toEqual([{ region: null }]);

    const runner = (sql: string) => rows(db, sql);
    const verdict: IntegrityResult = await checkRollupReconciliation(runner);
    expect(verdict.skipped, 'home_totals exists after globals, so the check really ran').toBe(
      false,
    );
    expect(verdict.ok, verdict.detail).toBe(true);
  });

  it('a clean run leaves no touched tables behind (so a following empty window has nothing pending)', () => {
    readScript(db, workStagingSchema);
    seedWindow(db);
    runGroups(
      db,
      GROUPS.map((g) => g.name),
    );
    for (const table of TOUCHED_SET_TABLES) expect(tableExists(db, table)).toBe(false);
  });
});
