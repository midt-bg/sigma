/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The list pages paginate with a keyset ORDER BY <sortExpr> <dir>, <id> <dir> LIMIT N. When the sort
// column/expression has a matching index, SQLite walks it and stops at LIMIT. When it does NOT, the
// planner falls back to "SCAN <table> … USE TEMP B-TREE FOR ORDER BY": it reads and sorts the WHOLE
// table before applying LIMIT — a full-corpus scan on every request. D1 bills on rows SCANNED, so a
// missing ordering index is a real cost/latency defect (docs/review-security.md "D1 разход и индекси").
//
// This proves, on a real sqlite3 with no ANALYZE stats (matching production D1), that BEFORE the
// list-sort-indexes migration the six non-default list sorts full-scan (temp-B-tree sort), and AFTER
// it each walks its new index with no ORDER BY sort step — on the first page AND on a keyset page.
//
// Known boundaries of this guarantee (review ydimitrof):
// - The local sqlite3 CLI's query planner is not version-identical to Cloudflare D1's; the EXPLAIN
//   plans are a strong indication, not a bit-exact production proof. (The sqlite3 binary itself is a
//   pre-existing suite-wide dependency — migrations/refresh-slice/ship-domain tests all exec it — so
//   a missing binary fails the whole suite, not just this file.)
// - The index-walk claim covers the UNFILTERED sort paths (the default list views). With an active
//   filter the planner may prefer the filter's index and sort the (small) filtered set instead —
//   that is the correct trade, but it is not what this test asserts.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = resolve(root, 'packages/db/migrations');

// Apply EVERY migration on the branch, not a hardcoded subset — so the "BEFORE" base is exactly the
// real served schema minus this PR's index, and the test survives any renumbering (review ydimitrof).
const allMigrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const sortIndexMigration = allMigrations.find((f) => f.includes('list_sort_indexes'));
if (!sortIndexMigration) throw new Error('list_sort_indexes migration not found');
const baseMigrations = allMigrations.filter((f) => f !== sortIndexMigration);

function readScript(dbPath: string, file: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], {
    input: `.read ${resolve(migrationsDir, file)}\n`,
    stdio: 'pipe',
  });
}

function plan(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], {
    input: `EXPLAIN QUERY PLAN ${sql}\n`,
    encoding: 'utf8',
  });
}

// Faithful shapes of the keyset list queries (queries/{contracts,companies,authorities}.ts): the same
// FROM/JOINs and the same ORDER BY expression, on the first page (no cursor) and on a keyset page
// (the `WHERE (expr <cmp> ? OR (expr = ? AND id <cmp> ?))` seek every page after the first uses).
const CONTRACTS_FROM =
  'FROM contracts c JOIN tenders t ON t.id = c.tender_id ' +
  'JOIN authorities a ON a.id = t.authority_id JOIN bidders b ON b.id = c.bidder_id';

const SORTS = [
  {
    name: 'contracts date-desc',
    index: 'idx_contracts_signed_desc',
    firstPage: `SELECT c.id ${CONTRACTS_FROM} ORDER BY COALESCE(c.signed_at, '') DESC, c.id DESC LIMIT 16`,
    keysetPage: `SELECT c.id ${CONTRACTS_FROM} WHERE (COALESCE(c.signed_at, '') < '2023-05-20' OR (COALESCE(c.signed_at, '') = '2023-05-20' AND c.id < 'c:500')) ORDER BY COALESCE(c.signed_at, '') DESC, c.id DESC LIMIT 16`,
  },
  {
    name: 'contracts date-asc',
    index: 'idx_contracts_signed_asc',
    firstPage: `SELECT c.id ${CONTRACTS_FROM} ORDER BY COALESCE(c.signed_at, '9999-99') ASC, c.id ASC LIMIT 16`,
    keysetPage: `SELECT c.id ${CONTRACTS_FROM} WHERE (COALESCE(c.signed_at, '9999-99') > '2023-05-20' OR (COALESCE(c.signed_at, '9999-99') = '2023-05-20' AND c.id > 'c:500')) ORDER BY COALESCE(c.signed_at, '9999-99') ASC, c.id ASC LIMIT 16`,
  },
  {
    name: 'companies count-desc',
    index: 'idx_company_totals_count',
    firstPage: `SELECT bidder_id FROM company_totals ORDER BY contracts DESC, bidder_id DESC LIMIT 26`,
    keysetPage: `SELECT bidder_id FROM company_totals WHERE (contracts < 10 OR (contracts = 10 AND bidder_id < 'eik:100')) ORDER BY contracts DESC, bidder_id DESC LIMIT 26`,
  },
  {
    name: 'companies authorities-desc',
    index: 'idx_company_totals_authorities',
    firstPage: `SELECT bidder_id FROM company_totals ORDER BY authorities DESC, bidder_id DESC LIMIT 26`,
    keysetPage: `SELECT bidder_id FROM company_totals WHERE (authorities < 5 OR (authorities = 5 AND bidder_id < 'eik:100')) ORDER BY authorities DESC, bidder_id DESC LIMIT 26`,
  },
  {
    name: 'authorities count-desc',
    index: 'idx_authority_totals_count',
    firstPage: `SELECT authority_id FROM authority_totals ORDER BY contracts DESC, authority_id DESC LIMIT 26`,
    keysetPage: `SELECT authority_id FROM authority_totals WHERE (contracts < 10 OR (contracts = 10 AND authority_id < 'auth:50')) ORDER BY contracts DESC, authority_id DESC LIMIT 26`,
  },
  {
    name: 'authorities avg-desc',
    index: 'idx_authority_totals_avg',
    firstPage: `SELECT authority_id FROM authority_totals ORDER BY avg_eur DESC, authority_id DESC LIMIT 26`,
    keysetPage: `SELECT authority_id FROM authority_totals WHERE (avg_eur < 100 OR (avg_eur = 100 AND authority_id < 'auth:50')) ORDER BY avg_eur DESC, authority_id DESC LIMIT 26`,
  },
] as const;

// A modest, unanalyzed dataset — enough that the planner weighs a real table, none of ANALYZE's
// stats (production D1 never runs ANALYZE; verified via grep over scripts/ + migrations).
function seed(dbPath: string): void {
  const stmts: string[] = ['BEGIN;'];
  for (let i = 0; i < 40; i++)
    stmts.push(`INSERT INTO authorities(id,name) VALUES('auth:${i}','A${i}');`);
  for (let i = 0; i < 60; i++)
    stmts.push(`INSERT INTO bidders(id,name) VALUES('eik:${i}','B${i}');`);
  for (let i = 0; i < 120; i++)
    stmts.push(
      `INSERT INTO tenders(id,source_id,title,authority_id,cpv_code,procedure_type,status) ` +
        `VALUES('t:${i}','U${i}','T${i}','auth:${i % 40}','45000000','открита','awarded');`,
    );
  for (let i = 0; i < 600; i++)
    stmts.push(
      `INSERT INTO contracts(id,tender_id,bidder_id,amount,amount_eur,currency,value_flag,signed_at,bids_received) ` +
        `VALUES('c:${i}','t:${i % 120}','eik:${i % 60}',${i * 10},${i * 10},'EUR','ok','202${i % 5}-0${(i % 9) + 1}-15',${(i % 4) + 1});`,
    );
  for (let i = 0; i < 300; i++)
    stmts.push(
      `INSERT INTO company_totals(bidder_id,name,kind,eik_valid,won_eur,contracts,authorities,eu_eur) ` +
        `VALUES('eik:${i}','B${i}','company',1,${i * 100},${i % 50},${i % 20},0);`,
    );
  for (let i = 0; i < 200; i++)
    stmts.push(
      `INSERT INTO authority_totals(authority_id,name,spent_eur,contracts,suppliers,avg_eur,eu_eur) ` +
        `VALUES('auth:${i}','A${i}',${i * 1000},${i % 90},${i % 30},${i * 3},0);`,
    );
  stmts.push('COMMIT;');
  execFileSync('sqlite3', ['-bail', dbPath], { input: stmts.join('\n'), stdio: 'pipe' });
}

describe('list sort ordering indexes', () => {
  let dir: string;
  let before: string; // every migration EXCEPT the sort-index one (= real main minus this PR)
  let after: string; // every migration (base + the sort-index one)

  beforeAll(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'sigma-sort-idx-'));
    before = resolve(dir, 'before.sqlite');
    after = resolve(dir, 'after.sqlite');
    for (const db of [before, after]) {
      for (const m of baseMigrations) readScript(db, m);
      seed(db);
    }
    readScript(after, sortIndexMigration);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // The defect: without the ordering index, the sort sorts the whole table — first page AND keyset page.
  it.each(SORTS)('$name full-scans + sorts BEFORE the fix', ({ firstPage, keysetPage }) => {
    expect(plan(before, firstPage)).toContain('USE TEMP B-TREE FOR ORDER BY');
    expect(plan(before, keysetPage)).toContain('USE TEMP B-TREE FOR ORDER BY');
  });

  // The fix: each sort walks its dedicated index and drops the ORDER BY sort step — on both pages.
  it.each(SORTS)(
    '$name walks $index with no sort step AFTER the fix',
    ({ index, firstPage, keysetPage }) => {
      for (const sql of [firstPage, keysetPage]) {
        const p = plan(after, sql);
        expect(p).toContain(index);
        expect(p).not.toContain('USE TEMP B-TREE FOR ORDER BY');
      }
    },
  );
});
