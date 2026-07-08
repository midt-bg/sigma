#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const TABLES = [
  'authorities',
  'bidders',
  'tenders',
  'lots',
  'contracts',
  'amendments',
  'parties',
  'company_totals',
  'authority_totals',
  'home_totals',
  'sector_totals',
  'facet_counts',
  'flow_pairs',
  'search_index',
  'data_freshness',
];

const VOLATILE_COLUMNS = new Set(['created_at', 'refreshed_at']);

const [aArg, bArg] = process.argv.slice(2);
if (!aArg || !bArg) {
  console.error(
    'usage: node scripts/compare-served-sqlite.mjs <early+refresh sqlite-or-dir> <full sqlite-or-dir>',
  );
  process.exit(2);
}

const aDb = findSqlite(resolve(aArg));
const bDb = findSqlite(resolve(bArg));
console.log(`A (early+refresh) = ${aDb}`);
console.log(`B (full rebuild)  = ${bDb}`);
console.log('');
console.log('table                 rows(A|B)            diff(A\\B|B\\A)');

let failed = false;
for (const table of TABLES) {
  const cols = tableColumns(bDb, table).filter((name) => !VOLATILE_COLUMNS.has(name));
  if (cols.length === 0) throw new Error(`no comparable columns for ${table}`);
  const colList = cols.map(quoteIdent).join(', ');
  const [row] = sqliteJson(`
    ATTACH ${sqlString(aDb)} AS a;
    ATTACH ${sqlString(bDb)} AS b;
    SELECT
      (SELECT COUNT(*) FROM a.${quoteIdent(table)}) AS a_rows,
      (SELECT COUNT(*) FROM b.${quoteIdent(table)}) AS b_rows,
      (SELECT COUNT(*) FROM (
        SELECT ${colList} FROM a.${quoteIdent(table)}
        EXCEPT
        SELECT ${colList} FROM b.${quoteIdent(table)}
      )) AS a_not_b,
      (SELECT COUNT(*) FROM (
        SELECT ${colList} FROM b.${quoteIdent(table)}
        EXCEPT
        SELECT ${colList} FROM a.${quoteIdent(table)}
      )) AS b_not_a;
  `);
  const aNotB = Number(row?.a_not_b ?? 0);
  const bNotA = Number(row?.b_not_a ?? 0);
  if (aNotB !== 0 || bNotA !== 0) failed = true;
  console.log(
    `${table.padEnd(21)} ${String(`${row.a_rows}|${row.b_rows}`).padEnd(20)} ${aNotB}|${bNotA}`,
  );
}

if (failed) {
  console.error('\n✘ served-table convergence failed');
  process.exit(1);
}
console.log('\nOK: 0 divergence across all served tables');

function findSqlite(path) {
  if (statSync(path).isFile()) return path;
  let best = null;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.sqlite') &&
        entry.name !== 'metadata.sqlite'
      ) {
        const size = statSync(child).size;
        if (!best || size > best.size) best = { path: child, size };
      }
    }
  };
  walk(path);
  if (!best) throw new Error(`no sqlite database found under ${path}`);
  return best.path;
}

function tableColumns(db, table) {
  const rows = sqliteJson(`PRAGMA table_info(${sqlString(table)});`, db);
  return rows.map((row) => row.name).filter(Boolean);
}

function sqliteJson(sql, db = undefined) {
  const args = ['-json'];
  if (db) args.push(db, sql);
  const out = execFileSync('sqlite3', args, {
    input: db ? undefined : sql,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
  return out ? JSON.parse(out) : [];
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
