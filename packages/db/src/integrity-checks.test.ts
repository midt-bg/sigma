/// <reference types="node" />
// Reconciliation gate (#97) — exercises the pure check functions and assertIntegrity against a
// small sqlite fixture: a clean corpus passes, and one injected violation per invariant is caught
// and would exit the import non-zero. Mirrors the repo's SQL-test style (shell out to the sqlite3
// CLI), and injects the same `(sql) => rows[]` runner the import uses on the sqlite path.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertIntegrity,
  checkDateSanity,
  checkEikValidity,
  checkNoNegativeValues,
  checkRollupReconciliation,
  checkStagingReconciliation,
} from '../../../scripts/integrity-checks.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const schemaPath = resolve(root, 'packages/db/migrations/0000_init.sql');
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
  it('passes every check after precompute (rollups reconcile, no throw)', () => {
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
    const results = assertIntegrity(run, { label: 'test-clean', exit: false });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.find((r) => r.name === 'rollup-reconciliation')?.skipped).toBe(false);
    expect(results.find((r) => r.name === 'staging-reconciliation')?.skipped).toBe(false);
  });

  it('rollup reconciliation self-skips before precompute (empty rollups)', () => {
    const db = track(freshDb()); // no precompute → home_totals empty
    const result = checkRollupReconciliation(runner(db));
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe('reconciliation gate — injected violations', () => {
  it('rollup-reconciliation catches a drifted rollup', () => {
    const db = track(freshDb());
    precompute(db);
    sqlite(
      db,
      'UPDATE authority_totals SET spent_eur = spent_eur + 1000 WHERE authority_id = (SELECT MIN(authority_id) FROM authority_totals);',
    );
    const result = checkRollupReconciliation(runner(db));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/authority_totals/);
  });

  it('rollup-reconciliation catches an orphan contract (no authority)', () => {
    const db = track(freshDb());
    // a clean-valued contract whose tender_id resolves to no tender → unattributed
    sqlite(
      db,
      "INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, value_flag, amount_eur) VALUES ('c:orphan','t:nope','eik:131071587',9000,'EUR','2022-01-01','ok',9000);",
    );
    precompute(db);
    const result = checkRollupReconciliation(runner(db));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/orphan|unattributed/);
  });

  it('no-negative-values catches a negative ok amount_eur', () => {
    const db = track(freshDb());
    sqlite(db, "UPDATE contracts SET amount_eur = -100 WHERE id = 'c:1';");
    const result = checkNoNegativeValues(runner(db));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/negative amount_eur/);
  });

  it('eik-validity catches eik_valid=1 with a non-numeric eik_normalized', () => {
    const db = track(freshDb());
    sqlite(db, "UPDATE bidders SET eik_normalized = 'AB12' WHERE id = 'eik:131071587';");
    const result = checkEikValidity(runner(db));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/eik_valid=1/);
  });

  it('eik-validity catches eik_valid<>1 with a non-null eik_normalized', () => {
    const db = track(freshDb());
    sqlite(db, "UPDATE bidders SET eik_normalized = '131071587' WHERE id = 'name:NAMED BIDDER';");
    const result = checkEikValidity(runner(db));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/eik_valid<>1/);
  });

  it('date-sanity catches a signed_at before 2007', () => {
    const db = track(freshDb());
    sqlite(db, "UPDATE contracts SET signed_at = '1999-01-01' WHERE id = 'c:1';");
    const result = checkDateSanity(runner(db));
    expect(result.ok).toBe(false);
  });

  it('date-sanity catches a future signed_at', () => {
    const db = track(freshDb());
    sqlite(db, "UPDATE contracts SET signed_at = date('now','+5 day') WHERE id = 'c:1';");
    const result = checkDateSanity(runner(db));
    expect(result.ok).toBe(false);
  });

  it('staging-reconciliation catches more inserted than eligible candidates', () => {
    const db = track(freshDb());
    const inserted = Number(runner(db)('SELECT COUNT(*) AS n FROM contracts')[0].n);
    sqlite(
      db,
      `CREATE TABLE pipeline_stats (id INTEGER PRIMARY KEY CHECK (id=1), contract_candidates INTEGER NOT NULL, contracts_inserted INTEGER NOT NULL, computed_at TEXT NOT NULL);
       INSERT INTO pipeline_stats VALUES (1, ${inserted - 1}, ${inserted}, datetime('now'));`,
    );
    const result = checkStagingReconciliation(runner(db));
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/exceed eligible candidates/);
  });

  it('staging-reconciliation self-skips when pipeline_stats is stale', () => {
    const db = track(freshDb());
    const inserted = Number(runner(db)('SELECT COUNT(*) AS n FROM contracts')[0].n);
    sqlite(
      db,
      `CREATE TABLE pipeline_stats (id INTEGER PRIMARY KEY CHECK (id=1), contract_candidates INTEGER NOT NULL, contracts_inserted INTEGER NOT NULL, computed_at TEXT NOT NULL);
       INSERT INTO pipeline_stats VALUES (1, ${inserted}, ${inserted + 7}, datetime('now'));`,
    );
    const result = checkStagingReconciliation(runner(db));
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('assertIntegrity throws non-zero on a sign-flipped amount_eur (the import would exit 1)', () => {
    const db = track(freshDb());
    precompute(db);
    sqlite(db, "UPDATE contracts SET amount_eur = -amount_eur WHERE id = 'c:2';");
    expect(() => assertIntegrity(runner(db), { label: 'test-corrupt', exit: false })).toThrow(
      /integrity gate failed/,
    );
  });
});
