#!/usr/bin/env node
// Ship domain/reference tables from a sqlite work DB to a served D1, then run precompute.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertIntegrity } from './integrity-checks.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'apps/web');
const d1Name = process.env.SIGMA_D1_NAME || 'sigma';
const TABLES = [
  'authorities',
  'bidders',
  'tenders',
  'lots',
  'contracts',
  'amendments',
  'parties',
  'fx_rates',
  'nuts_regions',
  'data_freshness',
];
const MAX_BATCH_BYTES = 90_000;
const MAX_BATCH_ROWS = 400;
const MAX_FILE_BYTES = Number(process.env.SHIP_MAX_FILE_BYTES) || 64 * 1024 * 1024;

function arg(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

const workDb = arg('work-db') || arg('source');
if (!workDb || workDb === true) throw new Error('ship-domain requires --work-db=<path>');
const remote = !!arg('remote');
if (remote && !arg('yes')) throw new Error('--remote requires --yes');
const replaceRemote = !!arg('replace');
const allowShrink = !!arg('allow-shrink');
const persistTo = arg('persist-to');
const outDir = resolve(root, String(arg('out-dir') || '/tmp/sigma-ship-domain'));

function d1Args(extra) {
  const loc = remote ? '--remote' : '--local';
  const persistArgs = !remote && persistTo ? ['--persist-to', String(persistTo)] : [];
  return ['d1', 'execute', d1Name, loc, ...persistArgs, ...extra];
}

function d1File(file) {
  const attempts = Math.max(1, Number(process.env.SHIP_RETRIES) || 1);
  for (let i = 1; ; i += 1) {
    try {
      execFileSync('wrangler', d1Args(['--file', file]), { cwd: apiDir, stdio: 'inherit' });
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      const backoff = Math.min(30, 2 ** i);
      console.error(
        `!! d1 execute failed (attempt ${i}/${attempts}) for ${file}; retrying in ${backoff}s`,
      );
      execFileSync('sleep', [String(backoff)]);
    }
  }
}

function d1MigrationsApply() {
  const loc = remote ? '--remote' : '--local';
  const persistArgs = !remote && persistTo ? ['--persist-to', String(persistTo)] : [];
  execFileSync('wrangler', ['d1', 'migrations', 'apply', d1Name, loc, ...persistArgs], {
    cwd: apiDir,
    stdio: 'inherit',
  });
}

function d1Json(sql) {
  const out = execFileSync('wrangler', d1Args(['--json', '--command', sql]), {
    cwd: apiDir,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
  if (!out) return [];
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

function sqliteJson(sql) {
  const out = execFileSync('sqlite3', ['-json', String(workDb), sql], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
  return out ? JSON.parse(out) : [];
}

function sqlIdent(s) {
  return `"${String(s).replaceAll('"', '""')}"`;
}

function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replaceAll('\x00', '').replaceAll("'", "''")}'`;
}

function tableColumns(table) {
  return sqliteJson(`PRAGMA table_info(${sqlIdent(table)})`).map((r) => r.name);
}

function tableCount(table) {
  return Number(sqliteJson(`SELECT COUNT(*) AS n FROM ${sqlIdent(table)}`)[0]?.n || 0);
}

function targetCounts() {
  return Object.fromEntries(
    TABLES.map((table) => {
      const rows = d1Json(`SELECT COUNT(*) AS n FROM ${sqlIdent(table)}`);
      return [table, Number(rows[0]?.n || 0)];
    }),
  );
}

function applySqlChunks(label, statementSource) {
  mkdirSync(outDir, { recursive: true });
  let part = 0;
  let fileSql = '';
  const flush = () => {
    if (!fileSql.trim()) return;
    const file = resolve(outDir, `${label}.${String(part).padStart(3, '0')}.sql`);
    writeFileSync(file, fileSql);
    d1File(file);
    part += 1;
    fileSql = '';
  };
  for (const stmt of statementSource) {
    if (fileSql && Buffer.byteLength(fileSql) + Buffer.byteLength(stmt) > MAX_FILE_BYTES) flush();
    fileSql += stmt;
  }
  flush();
}

function insertStatements(table, cols, rows) {
  const prefix = `INSERT INTO ${sqlIdent(table)} (${cols.map(sqlIdent).join(', ')}) VALUES\n`;
  const statements = [];
  let batch = [];
  let bytes = Buffer.byteLength(prefix) + 2;
  const flush = () => {
    if (!batch.length) return;
    statements.push(prefix + batch.join(',\n') + ';\n');
    batch = [];
    bytes = Buffer.byteLength(prefix) + 2;
  };
  for (const row of rows) {
    const tuple = `(${cols.map((c) => sqlLiteral(row[c])).join(',')})`;
    const tupleBytes = Buffer.byteLength(tuple) + 2;
    if (batch.length && (batch.length >= MAX_BATCH_ROWS || bytes + tupleBytes > MAX_BATCH_BYTES))
      flush();
    batch.push(tuple);
    bytes += tupleBytes;
  }
  flush();
  return statements;
}

console.log(`==> shipping ${workDb} to D1 ${remote ? 'remote' : 'local'}`);
console.log('==> ensuring served D1 migrations are applied');
d1MigrationsApply();

const sourceCounts = Object.fromEntries(TABLES.map((table) => [table, tableCount(table)]));
for (const table of ['authorities', 'bidders', 'tenders', 'contracts']) {
  if (sourceCounts[table] === 0) throw new Error(`refusing to ship: source ${table} has 0 rows`);
}

const beforeCounts = targetCounts();
const targetPopulated = Object.values(beforeCounts).some((n) => n > 0);
if (remote && targetPopulated && !replaceRemote) {
  throw new Error('--remote target is populated; pass --replace with --yes to confirm replacement');
}
if (targetPopulated) {
  for (const table of ['authorities', 'bidders', 'tenders', 'contracts']) {
    if (
      !allowShrink &&
      beforeCounts[table] > 0 &&
      sourceCounts[table] < beforeCounts[table] * 0.5
    ) {
      throw new Error(
        `refusing to ship: source ${table} ${sourceCounts[table]} is less than half of target ${beforeCounts[table]}`,
      );
    }
  }
}

for (const table of TABLES) {
  const cols = tableColumns(table);
  const n = sourceCounts[table];
  console.log(`==> ${table}: ${n} rows`);
  function* tableStatements() {
    yield 'PRAGMA defer_foreign_keys=ON;\n';
    yield `DELETE FROM ${sqlIdent(table)};\n`;
    if (n === 0) return;
    const orderBy = cols.includes('id') ? ' ORDER BY "id"' : '';
    for (let offset = 0; offset < n; offset += MAX_BATCH_ROWS) {
      const rows = sqliteJson(
        `SELECT ${cols.map(sqlIdent).join(', ')} FROM ${sqlIdent(table)}${orderBy} LIMIT ${MAX_BATCH_ROWS} OFFSET ${offset}`,
      );
      yield* insertStatements(table, cols, rows);
    }
  }
  applySqlChunks(`ship-${table}`, tableStatements());
}

const afterCounts = targetCounts();
for (const table of TABLES) {
  if (afterCounts[table] !== sourceCounts[table]) {
    throw new Error(
      `ship verification failed for ${table}: source=${sourceCounts[table]} target=${afterCounts[table]}`,
    );
  }
}

console.log('==> precompute on served D1');
d1File(resolve(root, 'scripts/seed-state-owned.sql'));
d1File(resolve(root, 'scripts/precompute.sql'));

// Reconciliation gate (#97) on the served D1: rollups now exist (just precomputed), so the rollup
// checks run here — this is the database users read. Staging/pipeline_stats are not shipped, so the
// staging-reconciliation check self-skips. Fails the ship with a non-zero exit on any drift.
console.log('==> integrity gate on served D1');
assertIntegrity(d1Json, { label: `served D1 ${remote ? 'remote' : 'local'}` });
console.log('==> ship complete');
