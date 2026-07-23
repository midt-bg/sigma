/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// listRecentEntityContracts (queries/contracts.ts) selects `c.published_at` and orders by
// COALESCE(c.signed_at, c.published_at). `published_at` exists on BOTH `contracts` and `tenders`, so a
// wrong alias (`t.published_at`) would NOT error — it would silently order by the tender's publish date
// instead of the contract's, and the mock-D1 unit tests can't catch that. This runs the real SELECT
// shape against the real migrated schema, with the contract's and tender's published_at deliberately
// different, to prove the query reads the CONTRACT column (review ydimitrof).

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migration0 = resolve(root, 'packages/db/migrations/0000_init.sql');

function sqliteJson<T>(dbPath: string, sql: string): T[] {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
  return out ? (JSON.parse(out) as T[]) : [];
}

describe('listRecentEntityContracts column/alias against the real schema', () => {
  let dir: string;
  let dbPath: string;

  beforeAll(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'sigma-recent-'));
    dbPath = resolve(dir, 'test.sqlite');
    execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${migration0}\n`, stdio: 'pipe' });
    execFileSync('sqlite3', ['-bail', dbPath], {
      input: [
        `INSERT INTO authorities(id,name) VALUES('auth:1','A');`,
        `INSERT INTO bidders(id,name) VALUES('eik:1','B');`,
        // Tender publish date is DELIBERATELY different from the contract's.
        `INSERT INTO tenders(id,source_id,title,authority_id,cpv_code,procedure_type,status,published_at) ` +
          `VALUES('t:1','U1','T','auth:1','45000000','открита','awarded','2020-01-01');`,
        // No signing date → the ORDER BY falls back to the contract's published_at.
        `INSERT INTO contracts(id,tender_id,bidder_id,amount,amount_eur,currency,value_flag,signed_at,published_at,bids_received) ` +
          `VALUES('c:1','t:1','eik:1',1000,1000,'EUR','ok',NULL,'2024-09-09',1);`,
      ].join('\n'),
      stdio: 'pipe',
    });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads c.published_at (the contract column), distinct from t.published_at', () => {
    const rows = sqliteJson<{ cpub: string; tpub: string; ord: string }>(
      dbPath,
      `SELECT c.published_at AS cpub, t.published_at AS tpub,
              COALESCE(c.signed_at, c.published_at) AS ord
       FROM contracts c JOIN tenders t ON t.id = c.tender_id
       WHERE t.authority_id = 'auth:1'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cpub).toBe('2024-09-09'); // contract's own publish date
    expect(rows[0]?.tpub).toBe('2020-01-01'); // the tender's — proves the two columns differ
    // The recency fallback used by listRecentEntityContracts must resolve to the CONTRACT's date.
    expect(rows[0]?.ord).toBe('2024-09-09');
  });
});
