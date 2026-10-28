/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The homepage's recent single-offer contracts (listSingleOfferContracts, mode 'recent') sorted the whole
// contracts table before LIMIT; migration 0027 gives the query an index in its exact order. As in
// list-sort-indexes.test.ts: a real sqlite3 with no ANALYZE stats, before and after the migration.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = resolve(root, 'packages/db/migrations');
const all = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const migration = all.find((f) => f.includes('single_offer_recent_index'));
if (!migration) throw new Error('single_offer_recent_index migration not found');

const sqlite = (db: string, input: string) =>
  execFileSync('sqlite3', ['-bail', db], { input, encoding: 'utf8' });

// The query as queries/contracts.ts builds it.
const RECENT =
  'SELECT c.id FROM contracts c JOIN tenders t ON t.id = c.tender_id ' +
  'JOIN authorities a ON a.id = t.authority_id JOIN bidders b ON b.id = c.bidder_id ' +
  'WHERE c.bids_received = 1 AND c.amount_eur IS NOT NULL ' +
  'ORDER BY COALESCE(c.signed_at, c.published_at) DESC, c.id LIMIT 10';

function seed(db: string): void {
  const rows = ['BEGIN;'];
  for (let i = 0; i < 20; i++) {
    rows.push(`INSERT INTO authorities(id,name) VALUES('auth:${i}','A${i}');`);
    rows.push(`INSERT INTO bidders(id,name) VALUES('eik:${i}','B${i}');`);
  }
  for (let i = 0; i < 100; i++)
    rows.push(
      `INSERT INTO tenders(id,source_id,title,authority_id,cpv_code,procedure_type,status) ` +
        `VALUES('t:${i}','U${i}','T${i}','auth:${i % 20}','45000000','открита','awarded');`,
    );
  for (let i = 0; i < 500; i++)
    rows.push(
      `INSERT INTO contracts(id,tender_id,bidder_id,amount,amount_eur,currency,value_flag,signed_at,bids_received) ` +
        `VALUES('c:${i}','t:${i % 100}','eik:${i % 20}',${i},${i},'EUR','ok','202${i % 5}-0${(i % 9) + 1}-15',${(i % 4) + 1});`,
    );
  rows.push('COMMIT;');
  sqlite(db, rows.join('\n'));
}

describe('recent single-offer contracts index', () => {
  let dir: string;
  let before: string;
  let after: string;

  beforeAll(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'sigma-single-offer-'));
    before = resolve(dir, 'before.sqlite');
    after = resolve(dir, 'after.sqlite');
    for (const db of [before, after])
      for (const m of all.filter((f) => f !== migration))
        sqlite(db, `.read ${resolve(migrationsDir, m)}\n`);
    for (const db of [before, after]) seed(db);
    sqlite(after, `.read ${resolve(migrationsDir, migration)}\n`);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('sorts the whole table before the migration', () => {
    expect(sqlite(before, `EXPLAIN QUERY PLAN ${RECENT};\n`)).toContain(
      'USE TEMP B-TREE FOR ORDER BY',
    );
  });

  it('walks the index with no sort step after it, and returns the same rows', () => {
    const plan = sqlite(after, `EXPLAIN QUERY PLAN ${RECENT};\n`);
    expect(plan).toContain('idx_contracts_single_offer_recent');
    expect(plan).not.toContain('USE TEMP B-TREE FOR ORDER BY');
    expect(sqlite(after, `${RECENT};\n`)).toBe(sqlite(before, `${RECENT};\n`));
  });
});
