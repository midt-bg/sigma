/// <reference types="node" />
// A contract whose annex doubled it (value_flag='annex_total_suspect', #305) sums at its SIGNING value. The
// one-time 0002 currency backfill once wrote the doubled current value instead; these tests pin the three
// things that keep it from ever being summed again: the idempotent served-D1 repair (with the refresh's
// touched sets, so the next refresh rebuilds what the contracts feed), the fixed backfill, and the
// integrity-gate invariant. Invented data only.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAnnexTotalSuspectBasis } from '../../../scripts/integrity-checks.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrations = [
  'packages/db/migrations/0000_init.sql',
  'packages/db/migrations/0001_flow_pairs_bidder_index.sql',
  'packages/db/migrations/0002_current_value_currency.sql',
].map((p) => resolve(root, p));
const repair = resolve(root, 'scripts/repair-annex-total-suspect.sql');
const backfill = resolve(root, 'scripts/backfill-current-value-currency.sql');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', ['-bail', dbPath], { input: sql, encoding: 'utf8' });
}
function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
}
function json<T>(dbPath: string, sql: string): T[] {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
  return out ? (JSON.parse(out) as T[]) : [];
}
const runner = (dbPath: string) => (sql: string) => json<Record<string, unknown>>(dbPath, sql);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshDb(withCurrency = true): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'sigma-annex-total-'));
  dirs.push(dir);
  const db = resolve(dir, 'test.sqlite');
  for (const m of withCurrency ? migrations : migrations.slice(0, 1)) readScript(db, m);
  return db;
}

// Two authorities, a joint co-authority, three bidders. Amounts are chosen so every expected EUR value is
// exact: 1 955 830 BGN = 1 000 000 € at the peg; the foreign row converts at 0.9 € per unit.
const FIXTURE = `
INSERT INTO authorities (id, name) VALUES ('auth:1','Община Тест'),('auth:2','Тестово министерство'),('auth:3','Община Пример');
INSERT INTO tenders (id, source_id, title, authority_id, procedure_type, currency, status) VALUES
  ('t:1','UNP-1','Доставка','auth:1','открита процедура','BGN','awarded'),
  ('t:2','UNP-2','Услуга','auth:2','открита процедура','EUR','awarded');
INSERT INTO bidders (id, name, eik_normalized, eik_valid) VALUES
  ('eik:000000001','ТЕСТ ГРУП ЕООД','000000001',1),
  ('eik:000000002','ПРИМЕР АД','000000002',1),
  ('eik:000000003','ДЕМО ООД','000000003',1);
`;
// Rows: [id, tender, bidder, flag, currency, current_value_currency, signing, current, fx_rate, amount_eur]
const ROWS: [
  string,
  string,
  string,
  string,
  string,
  string | null,
  number | null,
  number | null,
  number | null,
  number | null,
][] = [
  // doubled BGN row: summed at the doubled current value → must become the signing value
  [
    'c:double-bgn',
    't:1',
    'eik:000000001',
    'annex_total_suspect',
    'BGN',
    'BGN',
    1955830,
    3911660,
    null,
    2000000,
  ],
  // already right: signing-based EUR amount
  [
    'c:right-eur',
    't:2',
    'eik:000000002',
    'annex_total_suspect',
    'EUR',
    'EUR',
    500000,
    1000000,
    null,
    500000,
  ],
  // no signing value: the current value in the amendment's currency (EUR, contract in BGN), was NULL
  [
    'c:no-signing',
    't:1',
    'eik:000000002',
    'annex_total_suspect',
    'BGN',
    'EUR',
    null,
    100000,
    null,
    null,
  ],
  // foreign currency at the row's fx_rate, doubled
  [
    'c:double-usd',
    't:2',
    'eik:000000003',
    'annex_total_suspect',
    'USD',
    'USD',
    1000,
    2000,
    0.9,
    1800,
  ],
  // other flags are never touched, whatever their amount
  ['c:ok', 't:2', 'eik:000000001', 'ok', 'EUR', 'EUR', 700000, 2000000, null, 2000000],
  ['c:annex', 't:1', 'eik:000000003', 'annex_suspect', 'BGN', 'BGN', 1955830, 99999999, null, 123],
];
function seed(db: string): void {
  sqlite(db, FIXTURE);
  const values = ROWS.map(
    ([id, tender, bidder, flag, cur, cvc, signing, current, fx, eur]) =>
      `('${id}','${tender}','${bidder}',${signing ?? current ?? 0},'${cur}','${flag}',${cvc === null ? 'NULL' : `'${cvc}'`},${signing ?? 'NULL'},${current ?? 'NULL'},${fx ?? 'NULL'},${eur ?? 'NULL'})`,
  ).join(',\n  ');
  sqlite(
    db,
    `INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, value_flag, current_value_currency, signing_value, current_value, fx_rate, amount_eur) VALUES\n  ${values};
     INSERT INTO contract_co_authorities (contract_id, authority_id, ordinal) VALUES ('c:double-bgn','auth:1',0),('c:double-bgn','auth:3',1);
     -- A framework agreement's own record (framework = 2) whose annex also doubled it: its ceiling is
     -- never summed, so its amount stays NULL and none of the three may give it one.
     INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, value_flag, current_value_currency, signing_value, current_value, fx_rate, amount_eur, framework)
     VALUES ('c:fa-ceiling','t:1','eik:000000001',1955830,'BGN','annex_total_suspect','BGN',1955830,3911660,NULL,NULL,2);`,
  );
}
const amounts = (db: string) =>
  Object.fromEntries(
    json<{ id: string; amount_eur: number | null }>(
      db,
      'SELECT id, amount_eur FROM contracts ORDER BY id',
    ).map((r) => [r.id, r.amount_eur]),
  );
const touched = (db: string) => ({
  contracts: json<{ id: string }>(db, 'SELECT id FROM refresh_touched_contracts ORDER BY id').map(
    (r) => r.id,
  ),
  bidders: json<{ bidder_id: string }>(
    db,
    'SELECT bidder_id FROM refresh_touched_bidders ORDER BY bidder_id',
  ).map((r) => r.bidder_id),
  authorities: json<{ authority_id: string }>(
    db,
    'SELECT authority_id FROM refresh_touched_authorities ORDER BY authority_id',
  ).map((r) => r.authority_id),
});

describe('repair-annex-total-suspect.sql', () => {
  it('sets the signing-based amount on doubled rows and touches what they feed', () => {
    const db = freshDb();
    seed(db);
    readScript(db, repair);

    const a = amounts(db);
    expect(a['c:double-bgn']).toBeCloseTo(1000000, 6);
    expect(a['c:right-eur']).toBe(500000);
    expect(a['c:no-signing']).toBe(100000);
    expect(a['c:double-usd']).toBeCloseTo(900, 9);
    expect(a['c:ok']).toBe(2000000);
    expect(a['c:annex']).toBe(123);
    expect(a['c:fa-ceiling']).toBeNull();

    expect(touched(db)).toEqual({
      contracts: ['c:double-bgn', 'c:double-usd', 'c:no-signing'],
      bidders: ['eik:000000001', 'eik:000000002', 'eik:000000003'],
      // lead authorities of the three, and the joint co-authority of the doubled BGN contract
      authorities: ['auth:1', 'auth:2', 'auth:3'],
    });
    // The scratch table never outlives the file.
    expect(
      json(db, "SELECT name FROM sqlite_master WHERE name = 'repair_annex_total_suspect'"),
    ).toEqual([]);
  });

  it('changes nothing on a second run', () => {
    const db = freshDb();
    seed(db);
    readScript(db, repair);
    const after = amounts(db);
    sqlite(
      db,
      'DELETE FROM refresh_touched_contracts; DELETE FROM refresh_touched_bidders; DELETE FROM refresh_touched_authorities;',
    );

    readScript(db, repair);
    expect(amounts(db)).toEqual(after);
    expect(touched(db)).toEqual({ contracts: [], bidders: [], authorities: [] });
  });

  it('keeps ids an earlier refresh left in the touched sets', () => {
    const db = freshDb();
    seed(db);
    sqlite(
      db,
      "CREATE TABLE refresh_touched_contracts (id TEXT PRIMARY KEY); INSERT INTO refresh_touched_contracts VALUES ('c:ok');",
    );
    readScript(db, repair);
    expect(touched(db).contracts).toEqual(['c:double-bgn', 'c:double-usd', 'c:no-signing', 'c:ok']);
  });
});

describe('backfill-current-value-currency.sql', () => {
  it('keeps an annex_total_suspect contract at its signing value', () => {
    const db = freshDb();
    seed(db);
    // As right after the 0002 ALTER: the currency column is empty and the amount is whatever v1 left.
    sqlite(
      db,
      "UPDATE contracts SET current_value_currency = NULL, amount_eur = 0, current_value_eur = 7 WHERE value_flag <> 'annex_suspect';",
    );
    readScript(db, backfill);

    const a = amounts(db);
    expect(a['c:double-bgn']).toBeCloseTo(1000000, 6);
    expect(a['c:right-eur']).toBe(500000);
    expect(a['c:double-usd']).toBeCloseTo(900, 9);
    // an ok contract still sums at its current value
    expect(a['c:ok']).toBe(2000000);
    // a framework agreement's ceiling never gets an amount, whatever v1 left in it
    expect(a['c:fa-ceiling']).toBeNull();
    // the doubled current value is never shown as a current EUR figure
    expect(
      json<{ id: string; current_value_eur: number | null }>(
        db,
        "SELECT id, current_value_eur FROM contracts WHERE value_flag = 'annex_total_suspect' ORDER BY id",
      ).map((r) => r.current_value_eur),
    ).toEqual([null, null, null, null, null]);
  });
});

describe('integrity gate — annex-total-suspect-basis', () => {
  it('fails on a doubled annex total and names the excess', async () => {
    const db = freshDb();
    seed(db);
    const r = await checkAnnexTotalSuspectBasis(runner(db));
    expect(r).toMatchObject({ name: 'annex-total-suspect-basis', ok: false, skipped: false });
    // three rows are off: two doubled (+1 000 000 € and +900 €) and one NULL that has a value
    expect(r.detail).toMatch(
      /^3 of 4 annex_total_suspect contract\(s\) carry an amount_eur other than their signing value \(Σ excess 1000900\.00 €\)/,
    );
  });

  it('passes once the repair has run', async () => {
    const db = freshDb();
    seed(db);
    readScript(db, repair);
    const r = await checkAnnexTotalSuspectBasis(runner(db));
    expect(r).toEqual({
      name: 'annex-total-suspect-basis',
      ok: true,
      skipped: false,
      detail: '4 annex_total_suspect contract(s) sum at their signing value',
    });
  });

  it('leaves a framework-agreement ceiling unsummed and does not count it', async () => {
    const db = freshDb();
    seed(db);
    readScript(db, repair);
    expect(amounts(db)['c:fa-ceiling']).toBeNull();
    // the ceiling is not among the four checked rows, and its NULL amount is not a failure
    expect(await checkAnnexTotalSuspectBasis(runner(db))).toMatchObject({
      ok: true,
      detail: '4 annex_total_suspect contract(s) sum at their signing value',
    });
  });

  it('tolerates float noise below a cent', async () => {
    const db = freshDb();
    seed(db);
    readScript(db, repair);
    sqlite(db, "UPDATE contracts SET amount_eur = amount_eur + 0.004 WHERE id = 'c:double-bgn';");
    expect((await checkAnnexTotalSuspectBasis(runner(db))).ok).toBe(true);
  });

  it('skips a schema before migration 0002 and a database without contracts', async () => {
    const before = freshDb(false);
    expect(await checkAnnexTotalSuspectBasis(runner(before))).toMatchObject({
      ok: true,
      skipped: true,
    });
    const empty = resolve(dirname(before), 'empty.sqlite');
    sqlite(empty, 'CREATE TABLE unrelated (id INTEGER);');
    expect(await checkAnnexTotalSuspectBasis(runner(empty))).toEqual({
      name: 'annex-total-suspect-basis',
      ok: true,
      skipped: true,
      detail: 'contracts table absent',
    });
  });
});
