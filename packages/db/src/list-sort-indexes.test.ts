/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
// This proves, on a real sqlite3 with no ANALYZE stats (matching production D1), that:
//   (a) BEFORE migration 0005 the six non-default list sorts full-scan (temp-B-tree sort), and
//   (b) AFTER 0005 each walks its new index with no ORDER BY sort step.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migration0 = resolve(root, 'packages/db/migrations/0000_init.sql');
const migration1 = resolve(root, 'packages/db/migrations/0001_flow_pairs_bidder_index.sql');
const migration2 = resolve(root, 'packages/db/migrations/0005_list_sort_indexes.sql');

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
}

function plan(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], {
    input: `EXPLAIN QUERY PLAN ${sql}\n`,
    encoding: 'utf8',
  });
}

// Faithful shapes of the keyset list queries (queries/{contracts,companies,authorities}.ts). Only the
// ORDER BY + FROM/JOINs drive the plan, so the SELECT list is trimmed to the id.
const CONTRACTS_FROM =
  'FROM contracts c JOIN tenders t ON t.id = c.tender_id ' +
  'JOIN authorities a ON a.id = t.authority_id JOIN bidders b ON b.id = c.bidder_id';

const SORTS = [
  {
    name: 'contracts date-desc',
    index: 'idx_contracts_signed_desc',
    sql: `SELECT c.id ${CONTRACTS_FROM} ORDER BY COALESCE(c.signed_at, '') DESC, c.id DESC LIMIT 16`,
  },
  {
    name: 'contracts date-asc',
    index: 'idx_contracts_signed_asc',
    sql: `SELECT c.id ${CONTRACTS_FROM} ORDER BY COALESCE(c.signed_at, '9999-99') ASC, c.id ASC LIMIT 16`,
  },
  {
    name: 'companies count-desc',
    index: 'idx_company_totals_count',
    sql: `SELECT bidder_id FROM company_totals ORDER BY contracts DESC, bidder_id DESC LIMIT 26`,
  },
  {
    name: 'companies authorities-desc',
    index: 'idx_company_totals_authorities',
    sql: `SELECT bidder_id FROM company_totals ORDER BY authorities DESC, bidder_id DESC LIMIT 26`,
  },
  {
    name: 'authorities count-desc',
    index: 'idx_authority_totals_count',
    sql: `SELECT authority_id FROM authority_totals ORDER BY contracts DESC, authority_id DESC LIMIT 26`,
  },
  {
    name: 'authorities avg-desc',
    index: 'idx_authority_totals_avg',
    sql: `SELECT authority_id FROM authority_totals ORDER BY avg_eur DESC, authority_id DESC LIMIT 26`,
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
  let before: string; // schema WITHOUT 0005 (current main)
  let after: string; // schema WITH 0005 (the fix)

  beforeAll(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'sigma-sort-idx-'));
    before = resolve(dir, 'before.sqlite');
    after = resolve(dir, 'after.sqlite');
    for (const db of [before, after]) {
      readScript(db, migration0);
      readScript(db, migration1);
      seed(db);
    }
    readScript(after, migration2);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // The defect: without the ordering index, every one of these sorts sorts the whole table.
  it.each(SORTS)('$name full-scans + sorts BEFORE the fix', ({ sql }) => {
    expect(plan(before, sql)).toContain('USE TEMP B-TREE FOR ORDER BY');
  });

  // The fix: each sort walks its dedicated index and drops the ORDER BY sort step entirely.
  it.each(SORTS)('$name walks $index with no sort step AFTER the fix', ({ index, sql }) => {
    const p = plan(after, sql);
    expect(p).toContain(index);
    expect(p).not.toContain('USE TEMP B-TREE FOR ORDER BY');
  });
});
