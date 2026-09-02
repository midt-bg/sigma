#!/usr/bin/env node
// Sigma ETL orchestrator for storage.eop.bg open-data buckets. Initial backfill and daily catch-up
// both route through scripts/load-eop.mjs; only the date window and derive mode differ.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeCatchupWindow,
  daysInWindow,
  fullDeriveIsSafe,
} from '../packages/ingest/src/ocds.ts';
import {
  dropTransientStagingStatements,
  fullClearTables,
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
    // wrangler writes the SQLITE error to stdout, not the exception message.
    const msg = `${err?.message ?? err} ${err?.stdout ?? ''} ${err?.stderr ?? ''}`;
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

/**
 * Does the served surface already hold an EOP/OCDS corpus? A COUNT, deliberately — never a date. It
 * exists only to tell „first run" apart from „a derive was interrupted"; see the refusal below for why
 * the same table must not be used to derive a watermark. Scoped to the two id namespaces so a seeded or
 * hand-imported row cannot make an empty database look populated.
 */
function servedCorpusRows() {
  const rows = safeD1(`
    SELECT COUNT(*) AS n
    FROM contracts
    WHERE id LIKE 'c:e:%' OR id LIKE 'c:o:%'
  `);
  return Number(rows[0]?.n ?? 0);
}

function resolveCatchupPlan() {
  const rawFrom = arg('from');
  const today = String(arg('today') || todayUtc());
  const lookbackDays = Number(arg('lookback-days') || DEFAULT_LOOKBACK_DAYS);
  const maxLoadedDate = latestLoadedDate();
  if (!maxLoadedDate) {
    // No watermark. That reads as „nothing is loaded" — and for a first run it IS, so the full backfill
    // below is right. But the two witnesses latestLoadedDate consults are both transient, and they can
    // fall silent together for a completely different reason:
    //   • raw_contracts is the transient staging, torn down in a finally after every load;
    //   • refresh-slice.sql NULLs data_freshness.as_of in its FIRST batch (`setup`, so a half-refreshed
    //     surface never advertises freshness) and rewrites it only in `globals`, eighteen batches later.
    //     Every batch is its own atomic statement group, so ANY failure in between leaves as_of NULL.
    // So an INTERRUPTED derive is indistinguishable from a cold start by watermark alone, and the
    // consequences differ sharply: a cold start wants the whole feed, while an interrupted derive over a
    // populated surface would silently re-derive from DEFAULT_FROM — a 2020→today rebuild opening with
    // DELETE FROM contracts on the live path, and on the --work-db path a narrow tail window that ships
    // wholesale over the served tables. Neither is what an interrupted run asked for.
    //
    // The served corpus tells the two apart, used ONLY as a yes/no — never as a date. It deliberately
    // does not become a third watermark: `contracts` carries publication dates, not the bucket days the
    // window is computed from (the served schema has no `source` column at all), and a publication date
    // that runs ahead of its bucket would move the window PAST buckets that were never loaded — silently
    // skipping them, which is worse than any rebuild. So: rows but no watermark ⇒ refuse and say why.
    // An operator who knows how far the interrupted run got states it with --from --derive=slice.
    // `--from` with no value parses as `true`, which is not a window (review lyubomir-bozhinov, #337).
    // Treated as present, it skipped this refusal and produced from="true", so the operator got
    // validateDay's cryptic „windowFrom must be YYYY-MM-DD" instead of the message that explains what
    // actually happened. Fail-closed either way, but only one of the two tells them what to do.
    const explicitFrom = typeof rawFrom === 'string' ? rawFrom : null;
    if (!explicitFrom && servedCorpusRows() > 0) {
      throw new Error(
        'catch-up cannot plan: no load watermark, but the served surface is not empty.\n' +
          '  Both witnesses are transient and empty right now — raw_contracts (torn down after each\n' +
          '  load) and data_freshness.as_of (NULLed by refresh-slice.sql until its final batches). That\n' +
          '  is what an INTERRUPTED derive looks like, and it is indistinguishable here from a first run.\n' +
          '  Refusing rather than guessing: planning from the default start would re-derive the whole\n' +
          '  feed over a populated surface.\n' +
          '  Fix, in order of preference:\n' +
          '    1. Re-run the interrupted derive to completion — it rewrites the watermark.\n' +
          '    2. State the tail explicitly: --from=YYYY-MM-DD --derive=slice (a narrow window MUST be\n' +
          '       a slice; a full derive rebuilds from staging and would drop everything older).\n' +
          '    3. --derive=full only with a window that reaches the start of the feed.',
      );
    }
    const from = String(explicitFrom || DEFAULT_FROM);
    const to = String(arg('to') || today);
    // Honour an explicit --derive here too. This branch defaults to `full` because its default window
    // starts at the feed's beginning — but the refusal above sends an operator here WITH a --from, and a
    // narrow window forced to a full derive is exactly the combination assertDeriveWindowSafe refuses.
    // Hardcoding `full` made the advertised recovery unusable: the plan printed fine and the live run
    // then refused it. So the recovery `--from=… --derive=slice` has to reach the dispatcher intact.
    const requestedDerive = arg('derive');
    const derive = requestedDerive && requestedDerive !== true ? String(requestedDerive) : 'full';
    return { from, to, maxLoadedDate, gapDays: daysInWindow(from, to), derive };
  }
  const window = computeCatchupWindow({ maxLoadedDate, today, lookbackDays });
  const from = String(arg('from') || window.from);
  const to = String(arg('to') || window.to);
  const gapDays = daysInWindow(from, to);
  const requestedDerive = arg('derive');
  // The catch-up window is gap-aware, so it only ever covers the tail of the feed. A full derive
  // rebuilds `contracts` from staging (normalize-raw.sql opens with DELETE FROM contracts), which
  // would drop every contract older than the window — so catch-up always derives a slice, however
  // wide the gap. An operator who really has loaded the whole feed can still pass --derive=full.
  const derive = requestedDerive && requestedDerive !== true ? String(requestedDerive) : 'slice';
  return { from, to, maxLoadedDate, gapDays, derive };
}

function validateDeriveMode(mode) {
  if (!['full', 'slice'].includes(mode))
    throw new Error(`unknown --derive=${mode}; expected full|slice`);
}

// Refuse the one combination that silently destroys data: a full derive (which rebuilds the domain
// from staging) driven by a window that does not reach back to the start of the feed. Anything the
// window misses is deleted and never reloaded. Checked before the load, and the refusal tears the
// transient staging back down: it cannot run any earlier, because the catch-up plan reads
// raw_contracts, but it must not leave a half-built schema behind for a run that never started.
//
// The question is asked of EVERY table the full clear empties, not of `contracts` alone: a corpus
// with no contracts but populated tenders, bidders or authorities is exactly the state a half-failed
// run leaves behind, and the narrow-window rebuild would then wipe those too while the guard waved
// it through. The list comes out of normalize-raw.sql itself (see @full-clear there).
function assertDeriveWindowSafe(mode, from) {
  if (mode !== 'full') return;
  const tables = fullClearTables(readFileSync(resolve(root, 'scripts/normalize-raw.sql'), 'utf8'));
  if (tables.length === 0)
    throw new Error(
      'normalize-raw.sql has no @full-clear block — refusing to guess what it clears',
    );
  // EXISTS per table, not COUNT(*) over the union: this runs on every full derive and must stay
  // cheap on a corpus of hundreds of thousands of rows.
  const probe = tables.map((t) => `(SELECT EXISTS(SELECT 1 FROM ${t})) AS "${t}"`).join(', ');
  const row = safeD1(`SELECT ${probe}`)[0];
  // safeD1 turns a missing table into an empty result, which would otherwise read as "no corpus" and
  // wave the destructive path through — one absent table blinding the guard about the other thirteen.
  // A probe that could not answer is not an answer: fail closed.
  if (!row || tables.some((table) => !(table in row))) {
    console.error(
      `!! refusing --derive=full: could not read the corpus. Every table normalize-raw.sql clears ` +
        `(${tables.join(', ')}) must be answerable before a rebuild may drop it.`,
    );
    execSqlStatements(dropTransientStagingStatements(), 'drop-transient-staging');
    process.exit(1);
  }
  const populated = Object.entries(row)
    .filter(([, present]) => Number(present) > 0)
    .map(([table]) => table);
  if (
    fullDeriveIsSafe({ windowFrom: from, feedStart: DEFAULT_FROM, hasCorpus: populated.length > 0 })
  )
    return;
  console.error(
    `!! refusing --derive=full: the load window starts ${from}, but the corpus is already ` +
      `populated back to ${DEFAULT_FROM}.\n` +
      `   A full derive rebuilds the domain from staging, so everything before ${from} would be ` +
      `dropped and not reloaded — including ${populated.join(', ')}.\n` +
      `   Use --derive=slice for an incremental refresh, or reload the whole feed with ` +
      `--from=${DEFAULT_FROM}.`,
  );
  execSqlStatements(dropTransientStagingStatements(), 'drop-transient-staging');
  process.exit(1);
}

async function runFullDerive() {
  // #306: link namespace-mismatched EOP annexes by value BEFORE derive-amendments.sql (its prefer-EOP
  // dedup would otherwise resurrect OCDS twins — review todorkolev #1). This STANDALONE script is the
  // full-derive form (candidates from the whole re-staged raw_contracts). The daily/slice + Worker path runs
  // an equivalent value anchor inside refresh-slice.sql that draws candidates from the served `contracts`
  // corpus instead of the window (so "unique on the procedure" is corpus-wide — review nikimilenkov HIGH 1).
  execSql(resolve(root, 'scripts/resolve-amendment-contracts.sql'));
  execSql(resolve(root, 'scripts/derive-amendments.sql'));
  run('node', ['scripts/load-fx.mjs', '--apply', ...passthru]);
  execSql(resolve(root, 'scripts/load-nuts.sql'));
  execSql(resolve(root, 'scripts/seed-state-owned.sql'));
  execSql(resolve(root, 'scripts/normalize-raw.sql'));
  execSql(resolve(root, 'scripts/promote-amendments.sql'));
  assertFxPopulated();
  execSql(resolve(root, 'scripts/precompute.sql'));
  await assertIntegrity(d1, { label: 'full derive (D1)' });
  reportAnomalies(d1, 'full derive (D1)');
}

async function runSliceDerive() {
  execSql(resolve(root, 'scripts/derive-amendments.sql'));
  run('node', ['scripts/load-fx.mjs', '--apply', ...passthru]);
  execSql(resolve(root, 'scripts/load-nuts.sql'));
  execSql(resolve(root, 'scripts/seed-state-owned.sql'));
  runRefreshSliceBatches();
  await assertIntegrity(d1, { label: 'slice derive (D1)' });
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

async function runWorkBackfill() {
  const rawWorkDb = arg('work-db');
  const workDb =
    rawWorkDb === true
      ? resolve(root, 'data/work/backfill.sqlite')
      : resolve(root, String(rawWorkDb));
  // Resolve the plan BEFORE touching anything. Both the catch-up refusal below and the one inside
  // resolveCatchupPlan are „do not proceed" verdicts, and proceeding far enough to delete the caller's
  // existing work DB and re-apply the migrations before announcing one is its own small act of damage.
  const plan = catchup ? resolveCatchupPlan() : null;
  if (plan) {
    console.log(
      `==> catchup window ${plan.from}..${plan.to} (${plan.gapDays} days, latest=${plan.maxLoadedDate || 'none'}, derive=${plan.derive})`,
    );
    // This path builds a FRESH work DB from the window and then ships it wholesale, so it always behaves
    // as a full derive no matter what the plan says — the line above prints a `derive` it does not act
    // on. That is survivable for a window reaching the start of the feed, and destructive for a tail:
    // everything outside it would be replaced by the tail. The refusal in resolveCatchupPlan recommends
    // exactly such a tail (`--from=… --derive=slice`), which is right for the live path and wrong here —
    // so refuse the contradiction loudly rather than silently ignoring the slice.
    // ALLOWLIST, not a denylist (review ydimitrof, #337). `!== 'full'` rather than `=== 'slice'`:
    // validateDeriveMode runs on the live path only — this function never reaches it — so an
    // unrecognised --derive would sail past a slice-only check and straight into the wholesale ship
    // below. „Anything I do not positively recognise" is the only safe default when the failure mode is
    // silent replacement of the served corpus.
    if (plan.derive !== 'full') {
      throw new Error(
        `--work-db catch-up can only run a full derive (got --derive=${plan.derive}): it rebuilds a\n` +
          `  fresh work DB from the window (${plan.from}..${plan.to}) and ships it WHOLESALE, so anything\n` +
          `  outside the window would be dropped from the served surface.\n` +
          `  Either run the slice against the live database (without --work-db), or widen the window to\n` +
          `  the start of the feed and state --derive=full.`,
      );
    }
  }

  const workDir = dirname(workDb);
  mkdirSync(workDir, { recursive: true });
  if (existsSync(workDb)) rmSync(workDb, { force: true });
  console.log(`==> Sigma import (work DB ${workDb})`);

  const migrationsDir = resolve(root, 'packages/db/migrations');
  const migrations = readdirSync(migrationsDir)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  for (const migration of migrations) sqliteFile(workDb, resolve(migrationsDir, migration));
  sqliteFile(workDb, resolve(root, 'scripts/work-staging-schema.sql'));

  const loadFlags = plan ? rangeFlags(plan.from, plan.to) : explicitRangeFlags();

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
  // #306: value-anchor resolver runs first on the full-derive path — see runFullDerive.
  sqliteFile(workDb, resolve(root, 'scripts/resolve-amendment-contracts.sql'));
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
  await assertIntegrity((sql) => sqliteJson(workDb, sql), { label: 'work backfill (sqlite)' });

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
  await runWorkBackfill();
  process.exit(0);
}

console.log(`==> Sigma import (${remote ? 'REMOTE' : 'local'})`);
run('wrangler', ['d1', 'migrations', 'apply', d1Name, loc, ...d1PersistArgs], apiDir);
execSqlStatements(dropTransientStagingStatements(), 'drop-stale-transient-staging');
// Must precede resolveCatchupPlan(): latestLoadedDate() reads raw_contracts, which lives here.
execSql(resolve(root, 'scripts/work-staging-schema.sql'));

let deriveMode = String(arg('derive') || 'full');
let loadFlags = explicitRangeFlags();
// Mirrors load-eop.mjs, which also falls back to DEFAULT_FROM when no --from is given.
let windowFrom = String(arg('from') || DEFAULT_FROM);
if (catchup) {
  const plan = resolveCatchupPlan();
  deriveMode = plan.derive;
  loadFlags = rangeFlags(plan.from, plan.to);
  windowFrom = plan.from;
  console.log(
    `==> catchup window ${plan.from}..${plan.to} (${plan.gapDays} days, latest=${plan.maxLoadedDate || 'none'}, derive=${deriveMode})`,
  );
}
validateDeriveMode(deriveMode);
assertDeriveWindowSafe(deriveMode, windowFrom);

run('node', ['scripts/load-eop.mjs', '--apply', ...loadFlags, ...passthru]);
if (deriveMode === 'slice') await runSliceDerive();
else await runFullDerive();
execSqlStatements(dropTransientStagingStatements(), 'drop-transient-staging');

console.log('\n==> import complete.');
