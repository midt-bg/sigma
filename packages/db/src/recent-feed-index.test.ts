/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The entity "newest contracts" RSS feeds (listRecentEntityContracts) run, scoped to one company or
// authority, `ORDER BY COALESCE(signed_at, published_at) DESC, id DESC LIMIT 50`. Without a matching
// scoped index the planner gathers ALL of the entity's contracts and does USE TEMP B-TREE FOR ORDER
// BY — a public, unauthenticated Denial-of-Wallet on a big supplier/ministry (D1 bills rows scanned).
// Migration 0006 adds the composite indexes (and denormalises authority_id onto contracts so the
// authority scope is a contract-row column). This proves, on a real sqlite3 without ANALYZE (matching
// D1), that BEFORE the migration both feeds temp-B-tree-sort, and AFTER each walks its scoped index.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = resolve(root, 'packages/db/migrations');
const feedMigration = readdirSync(migrationsDir).find((f) => f.includes('recent_feed_indexes'));
if (!feedMigration) throw new Error('recent_feed_indexes migration not found');
const baseMigrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql') && f !== feedMigration)
  .sort();

function readScript(dbPath: string, file: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], {
    input: `.read ${resolve(migrationsDir, file)}\n`,
    stdio: 'pipe',
  });
}

function exec(dbPath: string, sql: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: sql, stdio: 'pipe' });
}

function plan(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], {
    input: `EXPLAIN QUERY PLAN ${sql}\n`,
    encoding: 'utf8',
  });
}

const FROM =
  'FROM contracts c JOIN tenders t ON t.id = c.tender_id ' +
  'JOIN authorities a ON a.id = t.authority_id JOIN bidders b ON b.id = c.bidder_id';
const ORDER = 'ORDER BY COALESCE(c.signed_at, c.published_at) DESC, c.id DESC LIMIT 50';

const companyFeed = `SELECT c.id ${FROM} WHERE c.bidder_id = 'eik:0' ${ORDER}`;
// BEFORE denormalisation the authority feed had to scope via the tender (no authority_id on contracts).
const authorityFeedOld = `SELECT c.id ${FROM} WHERE t.authority_id = 'auth:0' ${ORDER}`;
// AFTER: scoped on the denormalised contract column, so idx_contracts_authority_recent applies.
const authorityFeedNew = `SELECT c.id ${FROM} WHERE c.authority_id = 'auth:0' ${ORDER}`;

function seed(dbPath: string, withAuthorityId: boolean): void {
  const stmts: string[] = ['BEGIN;'];
  for (let i = 0; i < 20; i++)
    stmts.push(`INSERT INTO authorities(id,name) VALUES('auth:${i}','A${i}');`);
  for (let i = 0; i < 30; i++)
    stmts.push(`INSERT INTO bidders(id,name) VALUES('eik:${i}','B${i}');`);
  for (let i = 0; i < 100; i++)
    stmts.push(
      `INSERT INTO tenders(id,source_id,title,authority_id,cpv_code,procedure_type,status) ` +
        `VALUES('t:${i}','U${i}','T${i}','auth:${i % 20}','45000000','открита','awarded');`,
    );
  for (let i = 0; i < 800; i++)
    stmts.push(
      `INSERT INTO contracts(id,tender_id,bidder_id,amount,amount_eur,currency,value_flag,signed_at,published_at,bids_received) ` +
        `VALUES('c:${i}','t:${i % 100}','eik:${i % 30}',1,1,'EUR','ok','202${i % 5}-0${(i % 9) + 1}-15','202${i % 5}-0${(i % 9) + 1}-10',1);`,
    );
  stmts.push('COMMIT;');
  exec(dbPath, stmts.join('\n'));
  // Mirror the ETL: populate the denormalised authority_id from the parent tender (migration 0006 does
  // the same via its backfill + the UPDATE steps in normalize-raw.sql / refresh-slice.sql).
  if (withAuthorityId)
    exec(
      dbPath,
      `UPDATE contracts SET authority_id = (SELECT t.authority_id FROM tenders t WHERE t.id = contracts.tender_id);`,
    );
}

describe('entity recent-contracts feed indexes', () => {
  let dir: string;
  let before: string;
  let after: string;

  beforeAll(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'sigma-recent-feed-'));
    before = resolve(dir, 'before.sqlite');
    after = resolve(dir, 'after.sqlite');
    for (const m of baseMigrations) readScript(before, m);
    seed(before, false);
    for (const m of baseMigrations) readScript(after, m);
    readScript(after, feedMigration);
    seed(after, true);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('company feed full-scans + temp-sorts BEFORE, index-walks AFTER', () => {
    expect(plan(before, companyFeed)).toContain('USE TEMP B-TREE FOR ORDER BY');
    const p = plan(after, companyFeed);
    expect(p).toContain('idx_contracts_bidder_recent');
    expect(p).not.toContain('USE TEMP B-TREE FOR ORDER BY');
  });

  it('authority feed full-scans + temp-sorts BEFORE, index-walks AFTER (via denormalised authority_id)', () => {
    expect(plan(before, authorityFeedOld)).toContain('USE TEMP B-TREE FOR ORDER BY');
    const p = plan(after, authorityFeedNew);
    expect(p).toContain('idx_contracts_authority_recent');
    expect(p).not.toContain('USE TEMP B-TREE FOR ORDER BY');
  });
});
