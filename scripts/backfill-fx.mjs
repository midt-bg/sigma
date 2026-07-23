#!/usr/bin/env node
// Legacy-NULL FX backfill (#158 follow-up). Contracts derived while fx_rates was empty (the cron
// bug window) sit in the SERVED D1 with amount_eur = NULL — silently missing from every rollup —
// and with the fx-dependent value_flag branches (value_suspect / review) mis-resolved to 'ok'.
// This repairs the served rows in place: load the missing ECB rates (shared fx.ts logic), recompute
// fx_rate / flags / EUR columns for exactly the damaged rows, then refresh the rollups through
// refresh-slice.sql's own touched-scoped batches — no staging, no re-ingest, no duplicated rollup
// SQL. See docs/adr/0008-legacy-fx-backfill.md.
//
//   node scripts/backfill-fx.mjs                    # report damage on local D1, exit 1 if any
//   node scripts/backfill-fx.mjs --apply            # repair local D1
//   node scripts/backfill-fx.mjs --apply --remote   # repair the served D1
//   node scripts/backfill-fx.mjs --work-db=data/work/sigma.db [--apply]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  FX_LOOKBACK_DAYS,
  FX_SOURCE,
  addDays,
  assertSameFinalHost,
  fxSeriesUrl,
  isCurrencyCode,
  isIsoDate,
  parseFxSeries,
} from '../packages/ingest/src/fx.ts';
import {
  refreshSliceStatementGroups,
  REFRESH_SLICE_ROLLUP_GROUPS,
} from '../packages/ingest/src/refresh.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PEG = 1.95583;

const stripControls = (s) => String(s).replace(/[\x00-\x1F]/g, '');
const sqlStr = (s) => (s == null ? 'NULL' : `'${stripControls(s).replace(/'/g, "''")}'`);

// The damage predicate — same shape as import.mjs's assertFxPopulated: foreign currency, no EUR
// amount, and not value_suspect (those are repaired from the procedure estimate, not FX).
const damage = (p = '') =>
  `${p}currency NOT IN ('BGN','EUR') AND ${p}amount_eur IS NULL AND ${p}value_flag <> 'value_suspect'`;
const DAMAGE = damage();

// Latest usable rate for `ccyExpr` at `dateExpr` — keep in sync with the fx_rate subqueries in
// scripts/refresh-slice.sql (same bounds, FX_LOOKBACK_DAYS carry-forward).
const rateAt = (dateExpr, ccyExpr) =>
  `(SELECT f.eur_per_unit FROM fx_rates f
     WHERE f.base_currency = ${ccyExpr}
       AND f.rate_date <= ${dateExpr}
       AND f.rate_date >= date(${dateExpr}, '-${FX_LOOKBACK_DAYS} days')
     ORDER BY f.rate_date DESC LIMIT 1)`;

// Tender estimate in EUR at the contract's signing date — keep in sync with the proc_est_eur CASE
// in scripts/refresh-slice.sql.
const procEstEur = `(SELECT CASE
    WHEN t.estimated_value IS NULL THEN NULL
    WHEN COALESCE(NULLIF(t.currency, ''), 'BGN') = 'EUR' THEN t.estimated_value
    WHEN COALESCE(NULLIF(t.currency, ''), 'BGN') = 'BGN' THEN t.estimated_value / ${PEG}
    ELSE t.estimated_value * ${rateAt('contracts.signed_at', `NULLIF(t.currency, '')`)}
  END FROM tenders t WHERE t.id = contracts.tender_id)`;

const procEstNative = `(SELECT t.estimated_value FROM tenders t WHERE t.id = contracts.tender_id)`;

// The derive's own effective value (COALESCE(current, signing) in EUR — refresh-slice.sql's
// eff_eur), NOT amount × fx_rate: for annex_suspect rows the served amount is the signing-side
// fallback while eff is current-based, and for BGN/EUR rows fx_rate is NULL.
const EFF = `(CASE
    WHEN COALESCE(NULLIF(contracts.currency, ''), 'BGN') = 'EUR'
      THEN COALESCE(contracts.current_value, contracts.signing_value)
    WHEN COALESCE(NULLIF(contracts.currency, ''), 'BGN') = 'BGN'
      THEN COALESCE(contracts.current_value, contracts.signing_value) / ${PEG}
    ELSE COALESCE(contracts.current_value, contracts.signing_value)
      * ${rateAt('contracts.signed_at', `NULLIF(contracts.currency, '')`)}
  END)`;

// The fx-dependent part of the derive's value_flag CASE (same precedence: value_suspect wins over
// any current flag, 'review' only upgrades 'ok' — the branches between them don't depend on FX
// and are already encoded in the current flag). Used both to DETECT flag-only damage and to
// repair it, so the two can never disagree.
const NEW_FLAG = `CASE
    WHEN ${EFF} > 2000000000 OR (${procEstEur} >= 1000 AND ${EFF} > 200 * ${procEstEur}) THEN 'value_suspect'
    WHEN contracts.value_flag = 'ok' AND ${procEstEur} > 0 AND ${EFF} >= 10 * ${procEstEur} THEN 'review'
    ELSE contracts.value_flag END`;

// Flag-only damage: the value_flag CASE also depends on the TENDER estimate's currency — a BGN/EUR
// (or priced foreign) contract whose tender estimate is foreign got its value_suspect/review
// branches mis-resolved when that rate was missing, with amount_eur perfectly populated. Detected
// by recomputing the flag with rates present and comparing.
const FLAG_CANDIDATE = `contracts.value_flag <> 'value_suspect'
  AND contracts.signed_at IS NOT NULL
  AND (SELECT t.estimated_value IS NOT NULL
         AND COALESCE(NULLIF(t.currency, ''), 'BGN') NOT IN ('BGN','EUR')
       FROM tenders t WHERE t.id = contracts.tender_id)`;

// Rollup batches to re-run after the repair — refresh-slice.sql's own statements, scoped by the
// refresh_touched_* tables we fill from the repaired set. Order matters (file order); the list
// itself lives next to the parser (packages/ingest/src/refresh.ts) and is shared with import.mjs.
const ROLLUP_GROUPS = REFRESH_SLICE_ROLLUP_GROUPS;

/** Damaged rows in the served DB: foreign currency, NULL amount_eur, not value_suspect.
 *  `interrupted` — a prior repair/refresh committed its row updates but died before finishing the
 *  rollup refresh: the refresh_touched_* tables it left behind (cleanup drops them last) still
 *  scope exactly the rows whose rollups are stale. */
export function reportFxDamage(runner) {
  const rows = runner.query(
    `SELECT c.id, c.contract_number, c.currency, c.signed_at, c.amount, c.value_flag
     FROM contracts c WHERE ${damage('c.')}
     ORDER BY c.currency, c.signed_at, c.contract_number`,
  );
  const byCurrency = {};
  for (const r of rows) byCurrency[r.currency] = (byCurrency[r.currency] ?? 0) + 1;
  const interrupted =
    runner.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'refresh_touched_contracts'`,
    ).length > 0;
  // Flag candidates whose tender-estimate rate is missing: their value_flag cannot be verified
  // offline — only counted here; --apply loads the rates and recomputes.
  const flagUnverified = Number(
    runner.query(
      `SELECT COUNT(*) AS n FROM contracts
       WHERE ${FLAG_CANDIDATE}
         AND NOT EXISTS (
           SELECT 1 FROM fx_rates f
           WHERE f.base_currency = (SELECT NULLIF(t.currency, '') FROM tenders t WHERE t.id = contracts.tender_id)
             AND f.rate_date <= contracts.signed_at
             AND f.rate_date >= date(contracts.signed_at, '-${FX_LOOKBACK_DAYS} days')
         )`,
    )[0]?.n ?? 0,
  );
  return { total: rows.length, byCurrency, rows, interrupted, flagUnverified };
}

// Rate coverage gaps: contract currencies for the damage set, plus foreign tender-estimate
// currencies for EVERY flag candidate (the value_suspect / review re-classification needs them
// whatever the contract's own currency is), per signing date.
function coverageGaps(runner) {
  return runner.query(
    `WITH needs (currency, d) AS (
       SELECT c.currency, c.signed_at FROM contracts c
       WHERE ${damage('c.')} AND c.signed_at IS NOT NULL
       UNION
       SELECT (SELECT NULLIF(t.currency, '') FROM tenders t WHERE t.id = contracts.tender_id),
              contracts.signed_at
       FROM contracts WHERE ${FLAG_CANDIDATE}
     )
     SELECT currency, MIN(d) AS min_date, MAX(d) AS max_date, COUNT(DISTINCT d) AS missing_dates
     FROM needs n
     WHERE n.currency IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM fx_rates f
       WHERE f.base_currency = n.currency AND f.rate_date <= n.d
         AND f.rate_date >= date(n.d, '-${FX_LOOKBACK_DAYS} days')
     )
     GROUP BY currency ORDER BY currency`,
  );
}

async function loadMissingRates(runner, { fetchFn, fetchedAt, api }) {
  const gaps = coverageGaps(runner);
  const fetched = [];
  const failures = [];
  for (const gap of gaps) {
    const c = String(gap.currency);
    if (!isCurrencyCode(c) || !isIsoDate(gap.min_date) || !isIsoDate(gap.max_date)) {
      fetched.push({ currency: c, status: 'invalid' });
      continue;
    }
    const start = addDays(String(gap.min_date), -FX_LOOKBACK_DAYS);
    const end = String(gap.max_date);
    try {
      const url = fxSeriesUrl(c, start, end, api);
      const res = await fetchFn(url);
      assertSameFinalHost(url, res.url);
      if (res.status === 404) {
        fetched.push({ currency: c, start, end, status: 'unsupported' });
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { rows, warnings } = parseFxSeries(await res.json(), c, `${start}..${end}`);
      for (const w of warnings) console.warn(`  ! ${w}`);
      if (rows.length > 0) {
        const values = rows
          .map(
            (r) =>
              `(${sqlStr(r.currency)}, ${sqlStr(r.rateDate)}, ${r.eurPerUnit}, ${sqlStr(FX_SOURCE)}, ${sqlStr(fetchedAt)})`,
          )
          .join(',\n  ');
        runner.exec(
          `INSERT OR REPLACE INTO fx_rates (base_currency, rate_date, eur_per_unit, source, fetched_at) VALUES\n  ${values};`,
        );
      }
      fetched.push({ currency: c, start, end, loaded: rows.length, status: 'ok' });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fetched.push({ currency: c, start, end, status: 'error', detail });
      failures.push(`${c}: ${detail}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`fx backfill: rate fetch failed — ${failures.join('; ')}`);
  }
  return fetched;
}

// The row repair over an existing refresh_touched_contracts set. Idempotent over correctly
// derived rows (recomputing with the same inputs converges), so a resumed run can safely re-apply
// it to a leftover touched set.
function repairRowsSql() {
  return [
    // Re-resolve the fx-dependent value_flag branches the bug window could not evaluate —
    // NEW_FLAG mirrors the value_flag CASE in scripts/refresh-slice.sql. The value_low
    // 5%-of-estimate branch needs raw-staging columns that do not survive to the served rows —
    // label-only residual, counted identically in every sum (ADR-0008).
    `UPDATE contracts SET value_flag = (${NEW_FLAG})
     WHERE id IN (SELECT id FROM refresh_touched_contracts);`,

    // Rows classified value_suspect: repaired from the procedure estimate, exactly like the
    // derive (amount := proc_est_native, amount_eur := proc_est_eur, timeline columns NULL).
    `UPDATE contracts SET
       amount = COALESCE(${procEstNative}, amount),
       amount_eur = ${procEstEur},
       signing_value_eur = NULL,
       current_value_eur = NULL
     WHERE id IN (SELECT id FROM refresh_touched_contracts) AND value_flag = 'value_suspect';`,

    // Remaining FOREIGN rows: the stored amount is already the flag-consistent native value
    // (display_native), so amount × fx_rate is the derive's own identity (see the contracts
    // schema comment on fx_rate). annex_suspect keeps current_value_eur suppressed. BGN/EUR
    // rows in the touched set were flag-only repairs — their EUR columns are already correct
    // and fx_rate is NULL, so they must never take this arithmetic.
    `UPDATE contracts SET
       amount_eur = amount * fx_rate,
       signing_value_eur = CASE WHEN signing_value IS NULL THEN NULL ELSE signing_value * fx_rate END,
       current_value_eur = CASE WHEN value_flag = 'annex_suspect' OR current_value IS NULL THEN NULL ELSE current_value * fx_rate END
     WHERE id IN (SELECT id FROM refresh_touched_contracts) AND value_flag <> 'value_suspect'
       AND COALESCE(NULLIF(currency, ''), 'BGN') NOT IN ('BGN','EUR');`,
  ].join('\n');
}

export function repairSql() {
  return [
    // 1. Price the damaged rows at their signing-date rate (NULL when no usable rate exists).
    `UPDATE contracts SET fx_rate = ${rateAt('contracts.signed_at', 'contracts.currency')}
     WHERE ${DAMAGE} AND signed_at IS NOT NULL;`,

    // 2. Capture every row that can actually be repaired — the priced damage set AND the
    //    flag-only candidates whose recomputed flag differs — plus their entities, for the
    //    rollup refresh (refresh-slice.sql's own touched-table mechanism, see its setup batch).
    `DROP TABLE IF EXISTS refresh_touched_contracts;`,
    `DROP TABLE IF EXISTS refresh_touched_bidders;`,
    `DROP TABLE IF EXISTS refresh_touched_authorities;`,
    `CREATE TABLE refresh_touched_contracts (id TEXT PRIMARY KEY);`,
    `CREATE TABLE refresh_touched_bidders (bidder_id TEXT PRIMARY KEY);`,
    `CREATE TABLE refresh_touched_authorities (authority_id TEXT PRIMARY KEY);`,
    `INSERT INTO refresh_touched_contracts SELECT id FROM contracts WHERE ${DAMAGE} AND fx_rate IS NOT NULL;`,
    `INSERT OR IGNORE INTO refresh_touched_contracts
       SELECT id FROM contracts WHERE ${FLAG_CANDIDATE} AND (${NEW_FLAG}) <> contracts.value_flag;`,
    `INSERT INTO refresh_touched_bidders SELECT DISTINCT bidder_id FROM contracts WHERE id IN (SELECT id FROM refresh_touched_contracts);`,
    `INSERT INTO refresh_touched_authorities SELECT DISTINCT t.authority_id FROM contracts c JOIN tenders t ON t.id = c.tender_id WHERE c.id IN (SELECT id FROM refresh_touched_contracts);`,

    // 3–5. The row repair itself (also runs standalone when resuming an interrupted run).
    repairRowsSql(),
  ].join('\n');
}

/**
 * Repair the served DB in place. Throws when a rate fetch fails while damage remains (fail loudly
 * rather than leave silent NULLs); currencies ECB cannot price are returned in `remaining`.
 *
 * Interruption-safe: the repair + rollup refresh go out as ONE exec (one wrangler/sqlite3
 * invocation), and if a prior run died between its row updates and its rollup refresh, the
 * refresh_touched_* tables it left behind are detected up front and its rollups are healed
 * first — before the early return and before any network fetch, so even a failing rate fetch
 * cannot strand them a second time.
 */
export async function backfillFx(runner, { fetchFn = fetch, fetchedAt, refreshSliceSql, api }) {
  const rollupSql = refreshSliceStatementGroups(refreshSliceSql)
    .filter((g) => ROLLUP_GROUPS.includes(g.name))
    .map((g) => g.statements.map((s) => `${s};`).join('\n'))
    .join('\n');

  const before = reportFxDamage(runner);
  let healed = false;
  if (before.interrupted) {
    // Scoped by the leftover touched tables. Re-applying the row repair too makes a partial
    // failure INSIDE the interrupted run's repair (not just between repair and rollups)
    // converge on retry; its cleanup drops the tables.
    runner.exec(`${repairRowsSql()}\n${rollupSql}`);
    healed = true;
  }
  if (before.total === 0 && before.flagUnverified === 0) {
    return { repaired: 0, reflagged: 0, remaining: [], fetched: [], healed, before };
  }

  const fetched = await loadMissingRates(runner, { fetchFn, fetchedAt, api });
  const reflagged = Number(
    runner.query(
      `SELECT COUNT(*) AS n FROM contracts WHERE ${FLAG_CANDIDATE} AND (${NEW_FLAG}) <> contracts.value_flag`,
    )[0]?.n ?? 0,
  );
  runner.exec(`${repairSql()}\n${rollupSql}`);

  const after = reportFxDamage(runner);
  return {
    repaired: before.total - after.total,
    reflagged,
    remaining: after.rows.map((r) => ({
      id: r.id,
      contract_number: r.contract_number,
      currency: r.currency,
      signed_at: r.signed_at,
    })),
    fetched,
    healed,
    before,
  };
}

// ---------------------------------------------------------------------------------------------
// CLI plumbing (same target model as scripts/load-fx.mjs: sqlite work DB / local D1 / remote D1).
function arg(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

function cliRunner() {
  const apiDir = resolve(root, 'apps/web');
  const workDb = arg('work-db');
  if (workDb === true) throw new Error('--work-db needs a value: --work-db=<path>');
  const remoteFlag = process.argv.includes('--remote') ? '--remote' : '--local';
  const persistTo = arg('persist-to');
  if (workDb && process.argv.includes('--remote'))
    throw new Error('--work-db and --remote are mutually exclusive');
  const d1Name = process.env.SIGMA_D1_NAME || 'sigma';
  const persistArgs =
    remoteFlag === '--local' && persistTo ? ['--persist-to', String(persistTo)] : [];
  // wrangler is a devDependency: `node scripts/backfill-fx.mjs` runs without node_modules/.bin on
  // PATH, so resolve the workspace binary first and fall back to a global install.
  const localWrangler = resolve(root, 'node_modules/.bin/wrangler');
  const wrangler = existsSync(localWrangler) ? localWrangler : 'wrangler';

  const query = (sql) => {
    if (workDb) {
      const out = execFileSync('sqlite3', ['-json', String(workDb), sql], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }).trim();
      return out ? JSON.parse(out) : [];
    }
    const out = execFileSync(
      wrangler,
      ['d1', 'execute', d1Name, remoteFlag, ...persistArgs, '--json', '--command', sql],
      { cwd: apiDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    return JSON.parse(out.slice(out.indexOf('[')))[0].results;
  };

  const exec = (sql) => {
    const outDir = resolve(root, 'data');
    mkdirSync(outDir, { recursive: true });
    const file = resolve(outDir, 'fx-backfill.sql');
    writeFileSync(file, `${sql}\n`);
    if (workDb) {
      // One transaction per exec: -bail aborts on the first error and the process exit rolls the
      // open transaction back, so a failed repair leaves the file exactly as it was.
      execFileSync('sqlite3', ['-bail', String(workDb)], {
        input: `BEGIN;\n${readFileSync(file, 'utf8')}\nCOMMIT;\n`,
        stdio: ['pipe', 'inherit', 'inherit'],
      });
    } else {
      execFileSync(
        wrangler,
        ['d1', 'execute', d1Name, remoteFlag, ...persistArgs, '--file', file],
        {
          cwd: apiDir,
          stdio: 'inherit',
        },
      );
    }
  };

  return { query, exec };
}

async function main() {
  const runner = cliRunner();
  const report = reportFxDamage(runner);
  console.log(`legacy-NULL foreign-currency contracts: ${report.total}`);
  for (const [ccy, n] of Object.entries(report.byCurrency)) console.log(`  ${ccy}: ${n}`);
  for (const r of report.rows.slice(0, 10)) {
    console.log(
      `  ${r.contract_number} ${r.currency} ${r.signed_at} amount=${r.amount} [${r.value_flag}]`,
    );
  }
  if (report.rows.length > 10) console.log(`  … ${report.rows.length - 10} more`);
  if (report.flagUnverified > 0) {
    console.log(
      `value_flag unverifiable offline (foreign tender-estimate currency without a loaded rate): ${report.flagUnverified}`,
    );
  }
  if (report.interrupted) {
    console.warn(
      'leftover refresh_touched_* tables: an earlier refresh/repair died before its rollup refresh — rollups may be stale.',
    );
  }

  const dirty = report.total > 0 || report.flagUnverified > 0 || report.interrupted;
  if (!process.argv.includes('--apply')) {
    if (dirty) {
      console.log('\nrun with --apply to repair (rates + EUR columns + flags + rollups).');
      process.exit(1);
    }
    console.log('clean — nothing to do.');
    return;
  }
  if (!dirty) {
    console.log('clean — nothing to do.');
    return;
  }

  const refreshSliceSql = readFileSync(resolve(root, 'scripts/refresh-slice.sql'), 'utf8');
  const summary = await backfillFx(runner, {
    fetchedAt: new Date().toISOString(),
    refreshSliceSql,
  });
  console.log(`\nrepaired: ${summary.repaired}, reflagged: ${summary.reflagged}`);
  if (summary.healed) console.log('healed the interrupted run’s stale rollups.');
  for (const f of summary.fetched) {
    console.log(
      `  fx ${f.currency} ${f.start ?? ''}..${f.end ?? ''} → ${f.loaded ?? 0} rates [${f.status}]`,
    );
  }
  if (summary.remaining.length > 0) {
    console.warn(`\nstill unpriced (no ECB rate available — see ADR-0008):`);
    for (const r of summary.remaining) {
      console.warn(`  ${r.contract_number} ${r.currency} ${r.signed_at}`);
    }
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
