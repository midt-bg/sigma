/// <reference types="node" />
// Reconciliation gate (#97) — exercises the pure check functions and assertIntegrity against a
// small sqlite fixture: a clean corpus passes, and one injected violation per invariant is caught
// and would exit the import non-zero. Mirrors the repo's SQL-test style (shell out to the sqlite3
// CLI), and injects the same `(sql) => rows[]` runner the import uses on the sqlite path. The checks
// are async (they `await runner`), so the call sites await; a synchronous runner still works because
// awaiting its array result is transparent.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE_SCHEMA } from './base-schema';
import {
  AMENDMENT_RAW_NUMBER_TWINS_SQL,
  assertIntegrity,
  CHECK_NAMES,
  CHECKS,
  checkAmendmentTwins,
  checkCurrentAmountParity,
  checkDateSanity,
  checkEikValidity,
  checkNoNegativeValues,
  checkNonEmptyCorpus,
  checkRollupReconciliation,
  checkStagingReconciliation,
  summarizeIntegrity,
} from '../../../scripts/integrity-checks.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migration1Path = resolve(root, 'packages/db/migrations/0001_flow_pairs_bidder_index.sql');
const migration2Path = resolve(root, 'packages/db/migrations/0002_current_value_currency.sql');
// precompute.sql's officials block reads interest_links (0003); build it so precompute doesn't fail.
const migration3Path = resolve(root, 'packages/db/migrations/0003_related_persons_foundation.sql');
// …and 0006, joined by the officials block for the Trade Register evidence gate (#279, ADR-0033).
const migration9Path = resolve(root, 'packages/db/migrations/0009_interest_link_evidence.sql');
// The officials search rows read person_registry_links (0014), interest_link_observations (0015) and
// person_sources (0018).
const personMigrationPaths = [
  // The officials search figure reads the Trade Register's roles (registry_roles, uncertain_after).
  'packages/db/migrations/0013_registry.sql',
  'packages/db/migrations/0014_person_profile.sql',
  'packages/db/migrations/0015_person_observations.sql',
  'packages/db/migrations/0017_registry_identity_observations.sql',
  'packages/db/migrations/0018_person_entities.sql',
].map((p) => resolve(root, p));
const precomputePath = resolve(root, 'scripts/precompute.sql');

function sqlite(dbPath: string, sql: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: sql, encoding: 'utf8', stdio: 'pipe' });
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
}

function runner(dbPath: string) {
  return (sql: string) => {
    const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
    return out ? JSON.parse(out) : [];
  };
}

// A clean corpus: 2 authorities, 2 tenders, 2 bidders (one valid ЕИК, one name-keyed), 3 clean
// contracts. Values are whole euros so the rollup sums reconcile exactly.
const CLEAN_FIXTURE = `
PRAGMA foreign_keys=ON;
INSERT INTO authorities (id, name) VALUES ('auth:1','Authority One'),('auth:2','Authority Two');
INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type, currency, status)
VALUES
  ('t:1','UNP-1','Tender One','auth:1','45000000','открита процедура','BGN','awarded'),
  ('t:2','UNP-2','Tender Two','auth:2','15000000','открита процедура','BGN','awarded');
INSERT INTO bidders (id, name, eik_normalized, eik_valid) VALUES
  ('eik:999000011','Valid Bidder','999000011',1),
  ('name:NAMED BIDDER','Named Bidder',NULL,0);
INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, value_flag, amount_eur)
VALUES
  ('c:1','t:1','eik:999000011',100000,'EUR','2021-05-01','ok',100000),
  ('c:2','t:1','name:NAMED BIDDER',250000,'EUR','2022-09-15','ok',250000),
  ('c:3','t:2','eik:999000011',50000,'EUR','2023-01-20','ok',50000);
`;

function freshDb(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'sigma-integrity-'));
  const dbPath = resolve(dir, 'test.sqlite');
  for (const file of BASE_SCHEMA) readScript(dbPath, file);
  readScript(dbPath, migration1Path);
  readScript(dbPath, migration2Path);
  readScript(dbPath, migration3Path);
  readScript(dbPath, migration9Path);
  for (const path of personMigrationPaths) readScript(dbPath, path);
  sqlite(dbPath, CLEAN_FIXTURE);
  return dbPath;
}

function precompute(dbPath: string): void {
  readScript(dbPath, precomputePath);
}

let dirs: string[] = [];
function track(dbPath: string): string {
  dirs.push(dirname(dbPath));
  return dbPath;
}

beforeEach(() => {
  dirs = [];
});
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('reconciliation gate — clean corpus', () => {
  it('passes every check after precompute (rollups reconcile, no throw)', async () => {
    const db = track(freshDb());
    precompute(db);
    const run = runner(db);
    // staging recon needs pipeline_stats; make it consistent so the check runs and passes.
    const inserted = Number(run('SELECT COUNT(*) AS n FROM contracts')[0].n);
    sqlite(
      db,
      `CREATE TABLE pipeline_stats (id INTEGER PRIMARY KEY CHECK (id=1), contract_candidates INTEGER NOT NULL, contracts_inserted INTEGER NOT NULL, computed_at TEXT NOT NULL);
       INSERT INTO pipeline_stats VALUES (1, ${inserted}, ${inserted}, datetime('now'));`,
    );
    const results = await assertIntegrity(run, { label: 'test-clean', exit: false });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.every((r) => !r.warn)).toBe(true); // clean corpus warns about nothing
    // A SKIP also satisfies `ok`, so assert every check that MUST apply here actually ran — otherwise a
    // check silently turning into a no-op SKIP would pass this test while the gate is inert for it.
    for (const nm of [
      'non-empty-corpus',
      'rollup-reconciliation',
      'current-amount-parity',
      'annex-total-suspect-basis',
      'no-negative-values',
      'eik-validity',
      'date-sanity',
      'staging-reconciliation',
      'amendment-twin-dedup',
    ])
      expect(results.find((r) => r.name === nm)?.skipped, `${nm} must not skip`).toBe(false);
  });

  it('runs against an async runner (the apps/etl D1 path)', async () => {
    const db = track(freshDb());
    precompute(db);
    const sync = runner(db);
    // Wrap the sync sqlite runner in a Promise-returning one, exactly like env.DB.prepare(sql).all().
    const asyncRunner = async (sql: string) => sync(sql);
    const results = await assertIntegrity(asyncRunner, { label: 'test-async', exit: false });
    expect(results.every((r) => r.ok)).toBe(true);
    // The rollup check must actually run (not silently skip) on the async path too.
    expect(results.find((r) => r.name === 'rollup-reconciliation')?.skipped).toBe(false);
  });

  it('rollup reconciliation self-skips before precompute (empty rollups)', async () => {
    const db = track(freshDb()); // no precompute → home_totals empty
    const result = await checkRollupReconciliation(runner(db));
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe('reconciliation gate — injected violations', () => {
  it('rollup-reconciliation catches a drifted rollup', async () => {
    const db = track(freshDb());
    precompute(db);
    sqlite(
      db,
      'UPDATE authority_totals SET spent_eur = spent_eur + 1000 WHERE authority_id = (SELECT MIN(authority_id) FROM authority_totals);',
    );
    const result = await checkRollupReconciliation(runner(db));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/authority_totals/);
  });

  it('rollup-reconciliation catches an orphan contract (no authority)', async () => {
    const db = track(freshDb());
    // a clean-valued contract whose tender_id resolves to no tender → unattributed
    sqlite(
      db,
      "INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, value_flag, amount_eur) VALUES ('c:orphan','t:nope','eik:999000011',9000,'EUR','2022-01-01','ok',9000);",
    );
    precompute(db);
    const result = await checkRollupReconciliation(runner(db));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/orphan|unattributed/);
  });

  it('current-amount-parity catches a detail/rollup EUR disagreement over one cent', async () => {
    const db = track(freshDb());
    precompute(db); // populates home_totals so the check runs (it gates on precompute like rollup-recon)
    sqlite(
      db,
      "UPDATE contracts SET current_value = 100000, amount_eur = 100000, current_value_eur = 100000.02 WHERE id = 'c:1';",
    );
    const result = await checkCurrentAmountParity(runner(db));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/1 ok contract.*amount_eur != current_value_eur/);
  });

  it('current-amount-parity accepts paired NULLs only without a usable rate', async () => {
    const db = track(freshDb());
    precompute(db);
    sqlite(
      db,
      "UPDATE contracts SET current_value = 100000, current_value_currency = 'CHF', amount_eur = NULL, current_value_eur = NULL WHERE id = 'c:1'",
    );
    expect(await checkCurrentAmountParity(runner(db))).toMatchObject({ ok: true, skipped: false });

    sqlite(
      db,
      `INSERT INTO fx_rates (base_currency, rate_date, eur_per_unit, source, fetched_at)
       SELECT DISTINCT 'CHF', signed_at, 1, 'test', 'test' FROM contracts WHERE current_value IS NOT NULL`,
    );
    expect((await checkCurrentAmountParity(runner(db))).ok).toBe(false);
  });

  it('current-amount-parity accepts sub-cent floating-point drift', async () => {
    const db = track(freshDb());
    precompute(db);
    sqlite(
      db,
      "UPDATE contracts SET current_value = 100000, amount_eur = 100000, current_value_eur = 100000.009 WHERE id = 'c:1';",
    );
    expect((await checkCurrentAmountParity(runner(db))).ok).toBe(true);
  });

  it('no-negative-values catches a negative ok amount_eur (Sigma derivation bug → hard fail)', async () => {
    const db = track(freshDb());
    sqlite(db, "UPDATE contracts SET amount_eur = -100 WHERE id = 'c:1';");
    const result = await checkNoNegativeValues(runner(db));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/negative amount_eur/);
  });

  it('no-negative-values WARNs (does NOT fail) on a non-ok negative amount_eur (upstream value_low)', async () => {
    const db = track(freshDb());
    // a value_low row keeps a populated, negative amount_eur that precompute still sums — upstream
    // source defect (#19–27) Sigma cannot fix, so it is surfaced loudly but must not break the import.
    sqlite(db, "UPDATE contracts SET value_flag = 'value_low', amount_eur = -5 WHERE id = 'c:1';");
    const result = await checkNoNegativeValues(runner(db));
    expect(result.ok).toBe(true);
    expect(result.warn).toBe(true);
    expect(result.detail).toMatch(/non-'ok'.*negative amount_eur/);
  });

  it('no-negative-values catches a negative rollup total (after precompute — exercises the rollup branch)', async () => {
    const db = track(freshDb());
    precompute(db); // build the rollups so the branch actually runs (the ok-amount test does not)
    sqlite(
      db,
      'UPDATE authority_totals SET spent_eur = -1 WHERE authority_id = (SELECT MIN(authority_id) FROM authority_totals);',
    );
    const result = await checkNoNegativeValues(runner(db));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/authority_totals\.spent_eur rows are negative/);
  });

  it('non-empty-corpus fails on an empty corpus (a silent empty ship cannot pass green)', async () => {
    const db = track(freshDb());
    sqlite(db, 'DELETE FROM contracts;');
    const result = await checkNonEmptyCorpus(runner(db));
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.detail).toMatch(/EMPTY corpus/);
  });

  // #286/#302: the OCDS→EOP bridge lets an OCDS amendment reach the same contract as its EOP twin, and
  // the prefer-EOP dedup (a DELETE two scripts earlier) is the SOLE guard, since promotion into
  // `amendments` is unconditional. This gate is that dedup's post-condition. The suite already pins the
  // dedup behaviourally; these cases pin the GATE — without them an `ok: n === 0` → `ok: true` edit
  // leaves every package green while the gate is inert.
  //
  // Sources are the real staged partition shapes: `eop:annexes:<day>` spanning 2020-05-08..2026-08-11 on
  // the live corpus, `ocds:<day>` only 2026 (the OCDS feed is go-forward). The gate matches by source
  // PREFIX, so the fixtures below use both ends of the real EOP range — a pattern pinned to one year
  // drops an arm and blows the count. The OCDS side cannot be spread the same way without inventing a
  // partition that does not exist, so an `ocds:2026%` narrowing stays out of reach of honest fixtures;
  // it is latent-in-2027, not a present regression.
  it('amendment-twin-dedup catches an EOP and an OCDS amendment on the same (unp, contract_number)', async () => {
    const db = track(freshDb());
    sqlite(
      db,
      `INSERT INTO amendments (id, natural_key, contract_number, unp, published_at, document_number, source)
       VALUES
         ('am:UNP-1:C-1:E1','am:UNP-1:C-1:E1','C-1','UNP-1','2026-03-05','E1','eop:annexes:2026-03-05'),
         ('am:UNP-1:C-1:ocds-1','am:UNP-1:C-1:ocds-1','C-1','UNP-1','2026-03-05','ocds-e82gsb-1','ocds:2026-03-05');`,
    );
    const result = await checkAmendmentTwins(runner(db));
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(false);
    // Anchor the COUNT (so `11` cannot satisfy `1`) but keep the prose match to the stable half of the
    // message, not the whole sentence.
    expect(result.detail).toMatch(/^1\b/);
    expect(result.detail).toMatch(/prefer-EOP dedup regressed/);
  });

  it('amendment-twin-dedup stays green on the shapes a working dedup actually leaves behind', async () => {
    const db = track(freshDb());
    sqlite(
      db,
      `INSERT INTO amendments (id, natural_key, contract_number, unp, published_at, document_number, source)
       VALUES
         -- two EOP annexes on one contract: the normal case, not a twin
         ('am:UNP-1:C-1:E1','am:UNP-1:C-1:E1','C-1','UNP-1','2022-03-01','E1','eop:annexes:2022-03-01'),
         ('am:UNP-1:C-1:E2','am:UNP-1:C-1:E2','C-1','UNP-1','2022-06-01','E2','eop:annexes:2022-06-01'),
         -- a genuinely OCDS-only annex on a DIFFERENT contract: what the dedup deliberately keeps
         ('am:UNP-2:C-2:ocds-1','am:UNP-2:C-2:ocds-1','C-2','UNP-2','2026-02-03','ocds-e82gsb-1','ocds:2026-02-03'),
         -- an OCDS row the bridge refused (still keyed by its OCID) next to an EOP annex on the same
         -- contract number: an honest residual, NOT double counting, because every consumer keys on
         -- (unp, contract_number) and this row's unp matches no contract — and no served tender names
         -- its procedure, so it cannot be proved the twin of UNP-1's annex either
         ('am:ocds-3:C-1:ocds-2','am:ocds-3:C-1:ocds-2','C-1','ocds-e82gsb-3','2026-04-07','ocds-e82gsb-2','ocds:2026-04-07'),
         -- NULL contract_number on both sides: cannot roll onto a contract, so it cannot double count
         ('am:UNP-3::E3','am:UNP-3::E3',NULL,'UNP-3','2026-05-06','E3','eop:annexes:2026-05-06'),
         ('am:UNP-3::ocds-3','am:UNP-3::ocds-3',NULL,'UNP-3','2026-05-06','ocds-e82gsb-4','ocds:2026-05-06'),
         -- NULL unp on both sides, same contract number: amendments.unp is nullable and both mappers
         -- can leave it empty, but such a row joins no contract either, so it must stay green too
         ('am:C-9:E4','am:C-9:E4','C-9',NULL,'2026-07-02','E4','eop:annexes:2026-07-02'),
         ('am:C-9:ocds-5','am:C-9:ocds-5','C-9',NULL,'2026-07-02','ocds-e82gsb-5','ocds:2026-07-02');`,
    );
    const result = await checkAmendmentTwins(runner(db));
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.detail).toMatch(/prefer-EOP dedup intact/);
  });

  // THREE offending pairs that deliberately share a value along each axis — (U1,C1), (U1,C2), (U2,C1) —
  // so the grouping key itself is pinned: collapsing it to `unp` alone counts 2, to `contract_number`
  // alone counts 2, and only the real composite key counts 3. One pair also carries two EOP rows, so
  // counting rows instead of pairs overshoots. The EOP sources sit at both ends of the real partition
  // range (2020 and 2026), which is what kills a year-pinned pattern.
  it('amendment-twin-dedup counts each offending pair once, keyed on BOTH columns', async () => {
    const db = track(freshDb());
    sqlite(
      db,
      `INSERT INTO amendments (id, natural_key, contract_number, unp, published_at, document_number, source)
       VALUES
         ('am:UNP-1:C-1:E1','am:UNP-1:C-1:E1','C-1','UNP-1','2020-05-08','E1','eop:annexes:2020-05-08'),
         ('am:UNP-1:C-1:E2','am:UNP-1:C-1:E2','C-1','UNP-1','2026-08-11','E2','eop:annexes:2026-08-11'),
         ('am:UNP-1:C-1:ocds-1','am:UNP-1:C-1:ocds-1','C-1','UNP-1','2026-01-04','ocds-e82gsb-1','ocds:2026-01-04'),
         -- ...and TWO OCDS rows, which the dedup would drop together: a gate that demanded exactly one
         -- row per side would walk straight past this pair
         ('am:UNP-1:C-1:ocds-4','am:UNP-1:C-1:ocds-4','C-1','UNP-1','2026-06-15','ocds-e82gsb-4','ocds:2026-06-15'),
         ('am:UNP-1:C-2:E3','am:UNP-1:C-2:E3','C-2','UNP-1','2023-09-12','E3','eop:annexes:2023-09-12'),
         ('am:UNP-1:C-2:ocds-2','am:UNP-1:C-2:ocds-2','C-2','UNP-1','2026-05-20','ocds-e82gsb-2','ocds:2026-05-20'),
         ('am:UNP-2:C-1:E4','am:UNP-2:C-1:E4','C-1','UNP-2','2026-08-11','E4','eop:annexes:2026-08-11'),
         ('am:UNP-2:C-1:ocds-3','am:UNP-2:C-1:ocds-3','C-1','UNP-2','2026-08-11','ocds-e82gsb-3','ocds:2026-08-11');`,
    );
    const result = await checkAmendmentTwins(runner(db));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/^3\b/);
  });

  // The same annex served twice under two identifier forms: the OCDS release still keyed by its OCID
  // (`ocds-` + six-character prefix + `-` + tender.id), the EOP annex under the УНП. The served tender
  // whose eop_tender_id is that tender.id names the УНП. Tender UNP-1 carries tender.id 101.
  it('amendment-twin-dedup catches an OCDS amendment served under its OCID beside its twin', async () => {
    const db = track(freshDb());
    sqlite(
      db,
      `UPDATE tenders SET eop_tender_id = '101' WHERE id = 't:1';
       UPDATE tenders SET eop_tender_id = '202' WHERE id = 't:2';
       INSERT INTO amendments (id, natural_key, contract_number, unp, published_at, document_number, source)
       VALUES
         ('am:UNP-1:C-1:E1','am:UNP-1:C-1:E1','C-1','UNP-1','2026-03-05','E1','eop:annexes:2026-03-05'),
         -- twin by the prefer-EOP rule: C-1 has an EOP annex under the УНП the OCID resolves to
         ('am:o101:C-1:R1','am:o101:C-1:R1','C-1','ocds-e82gsb-101','2026-03-05','ocds-e82gsb-101-1/x','ocds:2026-03-05'),
         -- stale alias: the same OCDS publication is served under the УНП as well
         ('am:UNP-2:C-3:R2','am:UNP-2:C-3:R2','C-3','UNP-2','2026-04-01','ocds-e82gsb-202-2/x','ocds:2026-04-01'),
         ('am:o202:C-3:R2','am:o202:C-3:R2','C-3','ocds-e82gsb-202','2026-04-01','ocds-e82gsb-202-2/x','ocds:2026-04-01');
       -- an OCDS-only procedure (its source_id is an OCID) that carries the same tender.id is no УНП, so
       -- it does not make the procedure ambiguous
       INSERT INTO tenders (id, source_id, title, authority_id, procedure_type, eop_tender_id)
       VALUES ('t:6','UNP-6','Tender Six','auth:1','открита процедура','606'),
              ('t:ocds-e82gsb-606','ocds-e82gsb-606','Tender Six (OCDS)','auth:1','открита процедура','606');
       INSERT INTO amendments (id, natural_key, contract_number, unp, published_at, document_number, source)
       VALUES
         ('am:UNP-6:C-6:E6','am:UNP-6:C-6:E6','C-6','UNP-6','2026-03-05','E6','eop:annexes:2026-03-05'),
         ('am:o606:C-6:R6','am:o606:C-6:R6','C-6','ocds-e82gsb-606','2026-03-05','ocds-e82gsb-606-1/x','ocds:2026-03-05');`,
    );
    const result = await checkAmendmentTwins(runner(db));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/^3 OCDS amendment\(s\) are served under their OCID/);
    // Both forms of the defect are reported side by side.
    sqlite(
      db,
      `INSERT INTO amendments (id, natural_key, contract_number, unp, published_at, document_number, source)
       VALUES ('am:UNP-1:C-1:R9','am:UNP-1:C-1:R9','C-1','UNP-1','2026-05-01','ocds-e82gsb-101-9/x','ocds:2026-05-01');`,
    );
    const both = await checkAmendmentTwins(runner(db));
    expect(both.detail).toMatch(/^1 \(unp, contract_number\).*; 3 OCDS amendment\(s\)/);
  });

  it('amendment-twin-dedup keeps OCID rows that are no proven twin', async () => {
    const db = track(freshDb());
    sqlite(
      db,
      `UPDATE tenders SET eop_tender_id = '101' WHERE id = 't:1';
       UPDATE tenders SET eop_tender_id = '101' WHERE id = 't:2';
       INSERT INTO tenders (id, source_id, title, authority_id, procedure_type, eop_tender_id)
       VALUES ('t:3','UNP-3','Tender Three','auth:1','открита процедура','303'),
              ('t:ocds-e82gsb-303','ocds-e82gsb-303','Tender Three (OCDS)','auth:1','открита процедура','404'),
              ('t:4','UNP-4','Tender Four','auth:1','открита процедура','404'),
              ('t:5','UNP-5','Tender Five','auth:1','открита процедура','505');
       INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, value_flag, amount_eur)
       VALUES ('c:o:9','t:ocds-e82gsb-303','eik:999000011',10,'EUR','2026-01-01','ok',NULL);
       INSERT INTO amendments (id, natural_key, contract_number, unp, published_at, document_number, source)
       VALUES
         ('am:UNP-1:C-1:E1','am:UNP-1:C-1:E1','C-1','UNP-1','2026-03-05','E1','eop:annexes:2026-03-05'),
         ('am:UNP-3:C-3:E3','am:UNP-3:C-3:E3','C-3','UNP-3','2026-03-05','E3','eop:annexes:2026-03-05'),
         ('am:UNP-5:C-5:R5','am:UNP-5:C-5:R5','C-5','UNP-5','2026-03-05','ocds-e82gsb-505-1/x','ocds:2026-03-05'),
         -- two served procedures claim tender.id 101: no single УНП, no proven twin
         ('am:o101:C-1:R1','am:o101:C-1:R1','C-1','ocds-e82gsb-101','2026-03-05','ocds-e82gsb-101-1/x','ocds:2026-03-05'),
         -- a contract hangs on this OCID itself: it is the key, not an alias
         ('am:o303:C-3:R3','am:o303:C-3:R3','C-3','ocds-e82gsb-303','2026-03-05','ocds-e82gsb-303-1/x','ocds:2026-03-05'),
         -- the only served tender with tender.id 404 besides an OCDS-only one resolves, but C-4 has no annex
         ('am:o404:C-4:R4','am:o404:C-4:R4','C-4','ocds-e82gsb-404','2026-03-05','ocds-e82gsb-404-1/x','ocds:2026-03-05'),
         -- C-5 has only an OCDS annex under the УНП, and it is a different publication
         ('am:o505:C-5:R6','am:o505:C-5:R6','C-5','ocds-e82gsb-505','2026-03-07','ocds-e82gsb-505-2/x','ocds:2026-03-07'),
         -- no served tender carries tender.id 999
         ('am:o999:C-1:R7','am:o999:C-1:R7','C-1','ocds-e82gsb-999','2026-03-05','ocds-e82gsb-999-1/x','ocds:2026-03-05');`,
    );
    const result = await checkAmendmentTwins(runner(db));
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/prefer-EOP dedup intact/);
  });

  // The value resolver moved an EOP annex published under number N-1 onto contract C-1 and kept N-1 in
  // contract_number_raw. The OCDS release of the same annex still carries N-1, so no (unp, contract_number)
  // comparison meets the two. Procedure UNP-7 has contract C-1; no contract carries N-1.
  it('amendment-twin-dedup catches an OCDS amendment served under the annex-side number of its EOP twin', async () => {
    const db = track(freshDb());
    sqlite(
      db,
      `INSERT INTO tenders (id, source_id, title, authority_id, procedure_type)
       VALUES ('t:UNP-7','UNP-7','Tender Seven','auth:1','открита процедура');
       INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, value_flag, amount_eur,
         contract_number)
       VALUES ('c:e:9','t:UNP-7','eik:900000001',10,'EUR','2026-01-01','ok',10,'C-1');
       INSERT INTO amendments (id, natural_key, contract_number, contract_number_raw, link_method, unp,
         published_at, document_number, source)
       VALUES
         ('am:UNP-7:N-1:E1','am:UNP-7:N-1:E1','C-1','N-1','value_anchor','UNP-7','2026-03-05','E1','eop:annexes:2026-03-05'),
         ('am:UNP-7:N-1:E2','am:UNP-7:N-1:E2','C-1','N-1','value_anchor','UNP-7','2026-04-05','E2','eop:annexes:2026-04-05'),
         ('am:UNP-7:N-1:R1','am:UNP-7:N-1:R1','N-1',NULL,NULL,'UNP-7','2026-03-05','ocds-e82gsb-7-1/x','ocds:2026-03-05'),
         ('am:UNP-7:N-1:R2','am:UNP-7:N-1:R2','N-1',NULL,NULL,'UNP-7','2026-04-05','ocds-e82gsb-7-2/x','ocds:2026-04-05');`,
    );
    const result = await checkAmendmentTwins(runner(db));
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.detail).toMatch(
      /^2 OCDS amendment\(s\) are served under the number their EOP twin was published under/,
    );
    // Removing them by the shared definition turns the gate green.
    sqlite(db, `DELETE FROM amendments WHERE id IN (${AMENDMENT_RAW_NUMBER_TWINS_SQL});`);
    await expect(checkAmendmentTwins(runner(db))).resolves.toMatchObject({ ok: true });
    expect(runner(db)("SELECT COUNT(*) AS n FROM amendments WHERE source LIKE 'eop:%'")).toEqual([
      { n: 2 },
    ]);
  });

  it('amendment-twin-dedup keeps OCDS rows whose number only coincides with an annex-side number', async () => {
    const db = track(freshDb());
    sqlite(
      db,
      `-- served ids follow the pipeline: a tender is 't:' || УНП
       INSERT INTO tenders (id, source_id, title, authority_id, procedure_type)
       VALUES ('t:UNP-7','UNP-7','Tender Seven','auth:1','открита процедура');
       INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, value_flag, amount_eur,
         contract_number)
       VALUES ('c:e:9','t:UNP-7','eik:900000001',10,'EUR','2026-01-01','ok',10,'N-2');
       INSERT INTO amendments (id, natural_key, contract_number, contract_number_raw, link_method, unp,
         published_at, document_number, source)
       VALUES
         ('am:UNP-7:N-1:E1','am:UNP-7:N-1:E1','C-1','N-1','value_anchor','UNP-7','2026-03-05','E1','eop:annexes:2026-03-05'),
         -- the same number in another procedure: no EOP annex of UNP-2 was published under it
         ('am:UNP-2:N-1:R1','am:UNP-2:N-1:R1','N-1',NULL,NULL,'UNP-2','2026-03-05','ocds-e82gsb-2-1/x','ocds:2026-03-05'),
         -- an annex-side number of another procedure's EOP annex
         ('am:UNP-3:C-3:E3','am:UNP-3:C-3:E3','C-3','N-3','value_anchor','UNP-3','2026-03-05','E3','eop:annexes:2026-03-05'),
         ('am:UNP-2:N-3:R3','am:UNP-2:N-3:R3','N-3',NULL,NULL,'UNP-2','2026-03-05','ocds-e82gsb-2-3/x','ocds:2026-03-05'),
         -- an annex-side number that names a contract of its own: that contract's annex input, kept
         ('am:UNP-7:N-2:E4','am:UNP-7:N-2:E4','C-1','N-2','value_anchor','UNP-7','2026-03-05','E4','eop:annexes:2026-03-05'),
         ('am:UNP-7:N-2:R4','am:UNP-7:N-2:R4','N-2',NULL,NULL,'UNP-7','2026-03-05','ocds-e82gsb-7-4/x','ocds:2026-03-05'),
         -- an EOP annex published under N-5 by number, never moved: two EOP rows, no OCDS twin
         ('am:UNP-7:N-5:E5','am:UNP-7:N-5:E5','N-5',NULL,NULL,'UNP-7','2026-03-05','E5','eop:annexes:2026-03-05');`,
    );
    const result = await checkAmendmentTwins(runner(db));
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/prefer-EOP dedup intact/);
  });

  it('amendment-twin-dedup self-skips when the amendments table is absent (staging-only DB)', async () => {
    const db = track(freshDb());
    sqlite(db, 'DROP TABLE amendments;');
    const result = await checkAmendmentTwins(runner(db));
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('eik-validity catches eik_valid=1 with a non-numeric eik_normalized', async () => {
    const db = track(freshDb());
    sqlite(db, "UPDATE bidders SET eik_normalized = 'AB12' WHERE id = 'eik:999000011';");
    const result = await checkEikValidity(runner(db));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/eik_valid=1/);
  });

  it('eik-validity catches eik_valid<>1 with a non-null eik_normalized', async () => {
    const db = track(freshDb());
    sqlite(db, "UPDATE bidders SET eik_normalized = '999000011' WHERE id = 'name:NAMED BIDDER';");
    const result = await checkEikValidity(runner(db));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/eik_valid<>1/);
  });

  it('date-sanity reports (warns, does NOT fail) a signed_at before 2007', async () => {
    const db = track(freshDb());
    sqlite(db, "UPDATE contracts SET signed_at = '1999-01-01' WHERE id = 'c:1';");
    const result = await checkDateSanity(runner(db));
    expect(result.ok).toBe(true);
    expect(result.warn).toBe(true);
    expect(result.detail).toMatch(/outside .* reported not gated/);
  });

  it('date-sanity reports (warns, does NOT fail) a future signed_at', async () => {
    const db = track(freshDb());
    sqlite(db, "UPDATE contracts SET signed_at = date('now','+5 day') WHERE id = 'c:1';");
    const result = await checkDateSanity(runner(db));
    expect(result.ok).toBe(true);
    expect(result.warn).toBe(true);
  });

  it('an out-of-range upstream date alone does NOT fail the import (consumer cannot fix source #19–27)', async () => {
    const db = track(freshDb());
    precompute(db);
    const inserted = Number(runner(db)('SELECT COUNT(*) AS n FROM contracts')[0].n);
    sqlite(
      db,
      `CREATE TABLE pipeline_stats (id INTEGER PRIMARY KEY CHECK (id=1), contract_candidates INTEGER NOT NULL, contracts_inserted INTEGER NOT NULL, computed_at TEXT NOT NULL);
       INSERT INTO pipeline_stats VALUES (1, ${inserted}, ${inserted}, datetime('now'));`,
    );
    // the exact real-world defect: a future signed_at typo in the source feed
    sqlite(db, "UPDATE contracts SET signed_at = '2029-05-14' WHERE id = 'c:1';");
    const results = await assertIntegrity(runner(db), { label: 'test-baddate', exit: false });
    expect(results.every((r) => r.ok)).toBe(true); // gate passes — import is NOT broken
    expect(results.find((r) => r.name === 'date-sanity')?.warn).toBe(true);
  });

  it('staging-reconciliation catches more inserted than eligible candidates', async () => {
    const db = track(freshDb());
    const inserted = Number(runner(db)('SELECT COUNT(*) AS n FROM contracts')[0].n);
    sqlite(
      db,
      `CREATE TABLE pipeline_stats (id INTEGER PRIMARY KEY CHECK (id=1), contract_candidates INTEGER NOT NULL, contracts_inserted INTEGER NOT NULL, computed_at TEXT NOT NULL);
       INSERT INTO pipeline_stats VALUES (1, ${inserted - 1}, ${inserted}, datetime('now'));`,
    );
    const result = await checkStagingReconciliation(runner(db));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/exceed eligible candidates/);
  });

  it('staging-reconciliation self-skips when pipeline_stats is stale', async () => {
    const db = track(freshDb());
    const inserted = Number(runner(db)('SELECT COUNT(*) AS n FROM contracts')[0].n);
    sqlite(
      db,
      `CREATE TABLE pipeline_stats (id INTEGER PRIMARY KEY CHECK (id=1), contract_candidates INTEGER NOT NULL, contracts_inserted INTEGER NOT NULL, computed_at TEXT NOT NULL);
       INSERT INTO pipeline_stats VALUES (1, ${inserted}, ${inserted + 7}, datetime('now'));`,
    );
    const result = await checkStagingReconciliation(runner(db));
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('assertIntegrity throws non-zero on a sign-flipped amount_eur (the import would exit 1)', async () => {
    const db = track(freshDb());
    precompute(db);
    sqlite(db, "UPDATE contracts SET amount_eur = -amount_eur WHERE id = 'c:2';");
    await expect(
      assertIntegrity(runner(db), { label: 'test-corrupt', exit: false }),
    ).rejects.toThrow(/integrity gate failed/);
  });
});

// The gate's message is what a Workflow step error and a CLI exit carry. On 2026-09-02 it said only
// "1 of 8 checks broke" and finding WHICH one meant re-running the whole roster by hand against the
// served D1. It must name the check and carry its detail — clipped, so no check can turn a step
// error into a page.
describe('summarizeIntegrity message', () => {
  const ok = (name: string) => ({ name, ok: true, skipped: false, detail: 'fine' });
  const broken = (name: string, detail: string) => ({ name, ok: false, skipped: false, detail });

  it('names every broken check with its detail', () => {
    const summary = summarizeIntegrity(
      [
        ok('non-empty-corpus'),
        broken(
          'rollup-reconciliation',
          'SUM(authority_totals.spent_eur) 1 != authority-attributed 2',
        ),
        ok('eik-validity'),
        broken('no-negative-values', '3 contracts with value_flag=ok have negative amount_eur'),
      ],
      'cron refresh',
    );
    expect(summary.ok).toBe(false);
    expect(summary.message).toBe(
      'integrity gate failed: 2 of 4 checks broke (cron refresh): ' +
        'rollup-reconciliation — SUM(authority_totals.spent_eur) 1 != authority-attributed 2; ' +
        'no-negative-values — 3 contracts with value_flag=ok have negative amount_eur.',
    );
  });

  it('clips a runaway detail and collapses its whitespace', () => {
    const detail = 'x'.repeat(1000) + '\n\n   tail';
    const summary = summarizeIntegrity([broken('date-sanity', detail)], 't');
    expect(summary.message).toMatch(
      /^integrity gate failed: 1 of 1 checks broke \(t\): date-sanity — x{399}…\.$/,
    );
  });

  it('bounds the whole message: past the budget the remaining checks are counted, not printed', () => {
    const many = Array.from({ length: 8 }, (_, i) => broken(`check-${i}`, 'x'.repeat(390)));
    const summary = summarizeIntegrity(many, 't');
    const message = summary.message!;
    expect(message.length).toBeLessThan(1400);
    expect(message).toMatch(/; \+\d+ more\.$/);
    expect(message).toContain('check-0 — ');
    expect(message).not.toContain('check-7 — ');
    const named = (message.match(/check-\d+ — /g) ?? []).length;
    const counted = Number(/\+(\d+) more\.$/.exec(message)![1]);
    expect(named + counted).toBe(8);
  });

  it('is null when nothing broke (warnings and skips are not violations)', () => {
    const summary = summarizeIntegrity(
      [
        ok('a'),
        { name: 'b', ok: true, skipped: true, detail: 'absent' },
        { ...ok('c'), warn: true },
      ],
      't',
    );
    expect(summary.ok).toBe(true);
    expect(summary.message).toBeNull();
  });
});

// The Worker names the check whose query failed before it has a result to read the name from, so the
// roster's ids are listed up front. A check added to CHECKS without its id — or an id renamed in one
// place only — would make the stored verdict name the wrong check.
describe('CHECK_NAMES', () => {
  it('lists every check id in roster order', async () => {
    // An empty answer to every query: each check self-skips or fails, and either way reports its id.
    const results = await Promise.all(CHECKS.map((check) => check(() => [])));
    expect(results.map((r) => r.name)).toEqual(CHECK_NAMES);
  });
});
