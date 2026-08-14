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
import {
  assertIntegrity,
  checkAmendmentTwins,
  checkCurrentAmountParity,
  checkDateSanity,
  checkEikValidity,
  checkNonEmptyCorpus,
  checkNoNegativeValues,
  checkRollupReconciliation,
  checkStagingReconciliation,
} from '../../../scripts/integrity-checks.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const schemaPath = resolve(root, 'packages/db/migrations/0000_init.sql');
const migration1Path = resolve(root, 'packages/db/migrations/0001_flow_pairs_bidder_index.sql');
const migration2Path = resolve(root, 'packages/db/migrations/0002_current_value_currency.sql');
// precompute.sql's officials block reads interest_links (0003); build it so precompute doesn't fail.
const migration3Path = resolve(root, 'packages/db/migrations/0003_related_persons_foundation.sql');
// …and 0006, joined by the officials block for the Trade Register evidence gate (#279, ADR-0033).
const migration9Path = resolve(root, 'packages/db/migrations/0009_interest_link_evidence.sql');
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
  ('eik:131071587','Valid Bidder','131071587',1),
  ('name:NAMED BIDDER','Named Bidder',NULL,0);
INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, value_flag, amount_eur)
VALUES
  ('c:1','t:1','eik:131071587',100000,'EUR','2021-05-01','ok',100000),
  ('c:2','t:1','name:NAMED BIDDER',250000,'EUR','2022-09-15','ok',250000),
  ('c:3','t:2','eik:131071587',50000,'EUR','2023-01-20','ok',50000);
`;

function freshDb(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'sigma-integrity-'));
  const dbPath = resolve(dir, 'test.sqlite');
  readScript(dbPath, schemaPath);
  readScript(dbPath, migration1Path);
  readScript(dbPath, migration2Path);
  readScript(dbPath, migration3Path);
  readScript(dbPath, migration9Path);
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
      "INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, value_flag, amount_eur) VALUES ('c:orphan','t:nope','eik:131071587',9000,'EUR','2022-01-01','ok',9000);",
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
         -- (unp, contract_number) and this row's unp matches no contract
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

  it('amendment-twin-dedup self-skips when the amendments table is absent (staging-only DB)', async () => {
    const db = track(freshDb());
    sqlite(db, 'DROP TABLE amendments;');
    const result = await checkAmendmentTwins(runner(db));
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('eik-validity catches eik_valid=1 with a non-numeric eik_normalized', async () => {
    const db = track(freshDb());
    sqlite(db, "UPDATE bidders SET eik_normalized = 'AB12' WHERE id = 'eik:131071587';");
    const result = await checkEikValidity(runner(db));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/eik_valid=1/);
  });

  it('eik-validity catches eik_valid<>1 with a non-null eik_normalized', async () => {
    const db = track(freshDb());
    sqlite(db, "UPDATE bidders SET eik_normalized = '131071587' WHERE id = 'name:NAMED BIDDER';");
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
