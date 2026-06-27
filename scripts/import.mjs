#!/usr/bin/env node
// Sigma ETL orchestrator for storage.eop.bg open-data buckets. Initial backfill and daily catch-up
// both route through scripts/load-eop.mjs; only the date window and derive mode differ.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeCatchupWindow, daysInWindow } from '../packages/ingest/src/ocds.ts';
import {
  dropTransientStagingStatements,
  refreshSliceStatementGroups,
} from '../packages/ingest/src/refresh.ts';
import { assertIntegrity } from './integrity-checks.mjs';
import { buildAnomalyReport, formatAnomalyReport } from './anomaly-report.mjs';

// Per-refresh anomaly report (#100): cross-row outliers the per-row value_flag can't see. OBSERVES
// only — wrapped so a detector bug or an odd corpus can never fail the import (contrast assertIntegrity,
// the hard gate). Prints the human-readable summary into the import log.
function reportAnomalies(runner, label) {
  try {
    const report = buildAnomalyReport(runner);
    console.log(`\n[${label}] ${formatAnomalyReport(report)}\n`);
  } catch (err) {
    console.warn(`[${label}] anomaly report skipped: ${err?.message ?? err}`);
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'apps/web');
const DEFAULT_FROM = '2020-01-01';
const LARGE_GAP_DAYS = 14;
const DEFAULT_LOOKBACK_DAYS = 3;

const remote = process.argv.includes('--remote');
const reset = process.argv.includes('--reset');
const catchup = process.argv.includes('--catchup');
const planOnly = process.argv.includes('--plan-only') || process.argv.includes('--dry-run');
const loc = remote ? '--remote' : '--local';
const persistTo = arg('persist-to');
const passthru = remote ? ['--remote'] : persistTo ? [`--persist-to=${String(persistTo)}`] : [];
const d1Name = process.env.SIGMA_D1_NAME || 'sigma';

function arg(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function rangeFlags(from, to) {
  return [`--from=${from}`, `--to=${to}`];
}

function explicitRangeFlags() {
  const flags = [];
  for (const name of ['from', 'to']) {
    const value = arg(name);
    if (value !== undefined && value !== true) flags.push(`--${name}=${value}`);
  }
  return flags;
}

function run(cmd, args, cwd = root, options = {}) {
  console.log(`
==> ${cmd} ${args.join(' ')}`);
  if (options.inputFile) {
    execFileSync(cmd, args, {
      input: execFileSync('cat', [options.inputFile]),
      stdio: ['pipe', 'inherit', 'inherit'],
      cwd,
    });
    return;
  }
  execFileSync(cmd, args, { stdio: 'inherit', cwd });
}

const d1PersistArgs = !remote && persistTo ? ['--persist-to', String(persistTo)] : [];
function execSql(file, label = basename(file)) {
  const startedAt = process.hrtime.bigint();
  run('wrangler', ['d1', 'execute', d1Name, loc, ...d1PersistArgs, '--file', file], apiDir);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  console.log(`==> batch timing ${label}: ${elapsedMs.toFixed(1)}ms`);
}

function execSqlStatements(statements, label) {
  const batchDirParent = resolve(root, 'data/work');
  mkdirSync(batchDirParent, { recursive: true });
  const batchDir = mkdtempSync(resolve(batchDirParent, 'sql-'));
  try {
    const file = resolve(batchDir, `${label}.sql`);
    writeFileSync(file, `${statements.join(';\n')};\n`, 'utf8');
    execSql(file, label);
  } finally {
    rmSync(batchDir, { recursive: true, force: true });
  }
}

function d1(sql) {
  const out = execFileSync(
    'wrangler',
    ['d1', 'execute', d1Name, loc, ...d1PersistArgs, '--json', '--command', sql],
    {
      cwd: apiDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const start = out.indexOf('[');
  if (start === -1) return [];
  return JSON.parse(out.slice(start))[0]?.results ?? [];
}

function safeD1(sql) {
  try {
    return d1(sql);
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (/no such table|does not exist/i.test(msg)) return [];
    throw err;
  }
}

function assertFxPopulated() {
  const rows = d1(
    "SELECT COUNT(*) AS missing_fx FROM contracts WHERE currency NOT IN ('BGN','EUR') " +
      "AND amount_eur IS NULL AND value_flag <> 'value_suspect'",
  );
  const missing = Number(rows[0]?.missing_fx ?? 0);
  if (missing > 0) {
    console.error(
      `!! FX assertion failed: ${missing} foreign-currency contracts have NULL amount_eur after normalize.`,
    );
    process.exit(1);
  }
}

function sqliteFile(dbPath, file) {
  run('sqlite3', ['-bail', dbPath], root, { inputFile: file });
}

function sqliteJson(dbPath, sql) {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
  return out ? JSON.parse(out) : [];
}

function assertFxPopulatedSqlite(dbPath) {
  const rows = sqliteJson(
    dbPath,
    "SELECT COUNT(*) AS missing_fx FROM contracts WHERE currency NOT IN ('BGN','EUR') " +
      "AND amount_eur IS NULL AND value_flag <> 'value_suspect'",
  );
  const missing = Number(rows[0]?.missing_fx ?? 0);
  if (missing > 0) {
    console.error(
      `!! FX assertion failed: ${missing} foreign-currency contracts have NULL amount_eur after normalize.`,
    );
    process.exit(1);
  }
}

function latestLoadedDate() {
  const rows = safeD1(`
    SELECT
      COUNT(*) AS rows,
      MAX(CASE
        WHEN substr(source, length(source) - 9, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        THEN substr(source, length(source) - 9, 10)
      END) AS max_source_day,
      MAX(CASE
        WHEN published_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        THEN published_at
      END) AS max_published_at
    FROM raw_contracts
    WHERE source LIKE 'eop:%' OR source LIKE 'ocds:%'
  `);
  const loadedRows = Number(rows[0]?.rows ?? 0);
  if (loadedRows > 0) return rows[0]?.max_source_day ?? rows[0]?.max_published_at ?? null;

  const fallback = safeD1(`
    SELECT MAX(as_of) AS max_loaded_date
    FROM data_freshness
    WHERE source IN ('eop', 'ocds')
      AND as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  `);
  return fallback[0]?.max_loaded_date ?? null;
}

function resolveCatchupPlan() {
  const today = String(arg('today') || todayUtc());
  const lookbackDays = Number(arg('lookback-days') || DEFAULT_LOOKBACK_DAYS);
  const maxLoadedDate = latestLoadedDate();
  if (!maxLoadedDate) {
    const from = String(arg('from') || DEFAULT_FROM);
    const to = String(arg('to') || today);
    return { from, to, maxLoadedDate, gapDays: daysInWindow(from, to), derive: 'full' };
  }
  const window = computeCatchupWindow({ maxLoadedDate, today, lookbackDays });
  const from = String(arg('from') || window.from);
  const to = String(arg('to') || window.to);
  const gapDays = daysInWindow(from, to);
  const requestedDerive = arg('derive');
  const derive =
    requestedDerive && requestedDerive !== true
      ? String(requestedDerive)
      : gapDays > LARGE_GAP_DAYS
        ? 'full'
        : 'slice';
  return { from, to, maxLoadedDate, gapDays, derive };
}

function validateDeriveMode(mode) {
  if (!['full', 'slice'].includes(mode))
    throw new Error(`unknown --derive=${mode}; expected full|slice`);
}

function runFullDerive() {
  execSql(resolve(root, 'scripts/derive-amendments.sql'));
  run('node', ['scripts/load-fx.mjs', '--apply', ...passthru]);
  execSql(resolve(root, 'scripts/load-nuts.sql'));
  execSql(resolve(root, 'scripts/seed-state-owned.sql'));
  execSql(resolve(root, 'scripts/normalize-raw.sql'));
  execSql(resolve(root, 'scripts/promote-amendments.sql'));
  assertFxPopulated();
  execSql(resolve(root, 'scripts/precompute.sql'));
  assertIntegrity(d1, { label: 'full derive (D1)' });
  reportAnomalies(d1, 'full derive (D1)');
}

function runSliceDerive() {
  execSql(resolve(root, 'scripts/derive-amendments.sql'));
  run('node', ['scripts/load-fx.mjs', '--apply', ...passthru]);
  execSql(resolve(root, 'scripts/load-nuts.sql'));
  execSql(resolve(root, 'scripts/seed-state-owned.sql'));
  runRefreshSliceBatches();
  assertIntegrity(d1, { label: 'slice derive (D1)' });
  reportAnomalies(d1, 'slice derive (D1)');
}

function runRefreshSliceBatches() {
  const refreshSlicePath = resolve(root, 'scripts/refresh-slice.sql');
  const groups = refreshSliceStatementGroups(readFileSync(refreshSlicePath, 'utf8'));
  const batchDirParent = resolve(root, 'data/work');
  mkdirSync(batchDirParent, { recursive: true });
  const batchDir = mkdtempSync(resolve(batchDirParent, 'refresh-slice-'));
  try {
    for (const group of groups) {
      const file = resolve(batchDir, `${group.name}.sql`);
      writeFileSync(file, `${group.statements.join(';\n\n')};\n`, 'utf8');
      execSql(file, `refresh-slice:${group.name}`);
    }
  } finally {
    rmSync(batchDir, { recursive: true, force: true });
  }
}

function runWorkBackfill() {
  const rawWorkDb = arg('work-db');
  const workDb =
    rawWorkDb === true
      ? resolve(root, 'data/work/backfill.sqlite')
      : resolve(root, String(rawWorkDb));
  const workDir = dirname(workDb);
  mkdirSync(workDir, { recursive: true });
  if (existsSync(workDb)) rmSync(workDb, { force: true });
  console.log(`==> Sigma import (work DB ${workDb})`);

  sqliteFile(workDb, resolve(root, 'packages/db/migrations/0000_init.sql'));
  sqliteFile(workDb, resolve(root, 'scripts/work-staging-schema.sql'));

  let loadFlags = explicitRangeFlags();
  if (catchup) {
    const plan = resolveCatchupPlan();
    loadFlags = rangeFlags(plan.from, plan.to);
    console.log(
      `==> catchup window ${plan.from}..${plan.to} (${plan.gapDays} days, latest=${plan.maxLoadedDate || 'none'}, derive=${plan.derive})`,
    );
  }

  // Derive intermediate-SQL filenames from the work-DB basename so two backfills sharing a work
  // directory (e.g. a convergence harness running full + windowed loads side by side) never clobber
  // each other's load SQL.
  const stem = basename(workDb, '.sqlite');
  run('node', [
    'scripts/load-eop.mjs',
    '--apply',
    `--work-db=${workDb}`,
    `--out=${resolve(workDir, `${stem}.eop-load.sql`)}`,
    ...loadFlags,
  ]);
  sqliteFile(workDb, resolve(root, 'scripts/derive-amendments.sql'));
  run('node', [
    'scripts/load-fx.mjs',
    '--apply',
    `--work-db=${workDb}`,
    `--out=${resolve(workDir, `${stem}.fx-load.sql`)}`,
  ]);
  sqliteFile(workDb, resolve(root, 'scripts/load-nuts.sql'));
  sqliteFile(workDb, resolve(root, 'scripts/seed-state-owned.sql'));
  sqliteFile(workDb, resolve(root, 'scripts/normalize-raw.sql'));
  sqliteFile(workDb, resolve(root, 'scripts/promote-amendments.sql'));
  assertFxPopulatedSqlite(workDb);
  // Rollup checks self-skip here: the work DB's rollups are built later by precompute on the served
  // D1 (ship-domain.mjs), which runs its own assertIntegrity. This validates the work DB's
  // contract-level invariants and the staging→domain reconciliation before shipping.
  assertIntegrity((sql) => sqliteJson(workDb, sql), { label: 'work backfill (sqlite)' });

  const shipArgs = ['scripts/ship-domain.mjs', `--work-db=${workDb}`];
  if (remote) shipArgs.push('--remote', '--yes');
  if (arg('replace')) shipArgs.push('--replace');
  if (arg('allow-shrink')) shipArgs.push('--allow-shrink');
  if (persistTo) shipArgs.push(`--persist-to=${persistTo}`);
  run('node', shipArgs);
  console.log('\n==> work import complete.');
}

if (planOnly) {
  if (!catchup) throw new Error('--plan-only is only supported with --catchup');
  const plan = resolveCatchupPlan();
  validateDeriveMode(plan.derive);
  console.log(
    `==> catchup plan maxLoadedDate=${plan.maxLoadedDate || 'none'} from=${plan.from} to=${plan.to} gapDays=${plan.gapDays} derive=${plan.derive}`,
  );
  process.exit(0);
}

if (reset) {
  if (remote) {
    console.error(
      '!! --reset is local-only (refusing to wipe remote). Drop/recreate the remote D1 manually.',
    );
    process.exit(1);
  }
  const workState = resolve(root, 'data/work');
  if (existsSync(workState)) {
    rmSync(workState, { recursive: true, force: true });
    console.log('==> reset: removed data/work');
  }
  const state = resolve(apiDir, '.wrangler/state/v3/d1');
  if (existsSync(state)) {
    rmSync(state, { recursive: true, force: true });
    console.log('==> reset: removed local D1 state');
  }
}

if (arg('work-db') !== undefined) {
  runWorkBackfill();
  process.exit(0);
}

console.log(`==> Sigma import (${remote ? 'REMOTE' : 'local'})`);
run('wrangler', ['d1', 'migrations', 'apply', d1Name, loc, ...d1PersistArgs], apiDir);
execSqlStatements(dropTransientStagingStatements(), 'drop-stale-transient-staging');
execSql(resolve(root, 'scripts/work-staging-schema.sql'));

let deriveMode = String(arg('derive') || 'full');
let loadFlags = explicitRangeFlags();
if (catchup) {
  const plan = resolveCatchupPlan();
  deriveMode = plan.derive;
  loadFlags = rangeFlags(plan.from, plan.to);
  console.log(
    `==> catchup window ${plan.from}..${plan.to} (${plan.gapDays} days, latest=${plan.maxLoadedDate || 'none'}, derive=${deriveMode})`,
  );
}
validateDeriveMode(deriveMode);

run('node', ['scripts/load-eop.mjs', '--apply', ...loadFlags, ...passthru]);
if (deriveMode === 'slice') runSliceDerive();
else runFullDerive();
execSqlStatements(dropTransientStagingStatements(), 'drop-transient-staging');

console.log('\n==> import complete.');
