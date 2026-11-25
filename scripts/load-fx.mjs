#!/usr/bin/env node
// Fetch ECB euro reference rates (via the no-auth frankfurter API, which serves ECB data)
// for the foreign-currency contracts, into the fx_rates table — so scripts/normalize-raw.sql
// can convert those contracts to canonical EUR at the date-of-signing rate.
//
//   node scripts/load-fx.mjs            # fetch → data/fx-load.sql
//   node scripts/load-fx.mjs --apply    # also load into local D1
//   node scripts/load-fx.mjs --apply --remote
//
// The lev (BGN) is a fixed peg (1 EUR = 1.95583 BGN) handled inline in normalize; only the
// genuinely foreign currencies (USD/CHF/GBP/TRY/SEK/CZK …) need a market rate, and they are few.
// ECB publishes business-day rates only, so we load each used currency's full date range and let
// normalize carry the latest prior rate forward over weekends/holidays, bounded to 10 days.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  FX_COVERAGE_GAP_SQL,
  FX_LOOKBACK_DAYS,
  FX_SOURCE,
  addDays,
  assertSameFinalHost,
  discardBody,
  fxSeriesUrl,
  isCurrencyCode,
  isIsoDate,
  parseFxSeries,
} from '../packages/ingest/src/fx.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'apps/web');
const { values: cli } = parseArgs({ strict: false, allowPositionals: true });
const outFile = resolve(root, String(cli.out || 'data/fx-load.sql'));
const apply = process.argv.includes('--apply');
const remoteFlag = process.argv.includes('--remote') ? '--remote' : '--local';
const workDb = cli['work-db'];
const persistTo = cli['persist-to'];
if (workDb && process.argv.includes('--remote'))
  throw new Error('--work-db and --remote are mutually exclusive');
const d1Name = process.env.SIGMA_D1_NAME || 'sigma';
// The lookback, series URL and response validation are shared with the Worker cron path
// (packages/ingest/src/fx.ts) so the CLI and apps/etl cannot drift (#158).

const stripControls = (s) => String(s).replace(/[\x00-\x1F]/g, '');
const sqlStr = (s) => (s == null ? 'NULL' : `'${stripControls(s).replace(/'/g, "''")}'`);

function queryTarget(sql) {
  if (workDb) {
    const out = execFileSync('sqlite3', ['-json', String(workDb), sql], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
    return out ? JSON.parse(out) : [];
  }
  const persistArgs =
    remoteFlag === '--local' && persistTo ? ['--persist-to', String(persistTo)] : [];
  const out = execFileSync(
    'wrangler',
    ['d1', 'execute', d1Name, remoteFlag, ...persistArgs, '--json', '--command', sql],
    {
      cwd: apiDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

const ranges = queryTarget(FX_COVERAGE_GAP_SQL);
console.log(`foreign currency ranges to price: ${ranges.length}`);

const rows = [];
for (const { currency, min_date, max_date, missing_dates } of ranges) {
  const c = String(currency);
  if (!isCurrencyCode(c)) {
    console.warn(`  ! invalid currency ${currency}`);
    continue;
  }
  if (!isIsoDate(min_date) || !isIsoDate(max_date)) {
    console.warn(`  ! invalid date range ${currency} ${min_date}..${max_date}`);
    continue;
  }
  const start = addDays(String(min_date), -FX_LOOKBACK_DAYS);
  const end = String(max_date);
  const url = fxSeriesUrl(c, start, end);
  const res = await fetch(url);
  try {
    assertSameFinalHost(url, res.url);
  } catch (error) {
    discardBody(res);
    throw error;
  }
  if (!res.ok) {
    discardBody(res);
    if (res.status === 404) {
      console.warn(`  ! currency ${currency} not served by frankfurter`);
      continue;
    }
    throw new Error(`FX load failed for ${currency} ${start}..${end}: HTTP ${res.status}`);
  }
  const seriesRows = parseFxSeries(await res.json(), {
    base: c,
    quote: 'EUR',
    amount: 1,
    start,
    end,
  });
  for (const r of seriesRows)
    rows.push({ currency: r.currency, rate_date: r.rateDate, rate: r.eurPerUnit });
  console.log(
    `  ${currency} ${start}..${end} → ${seriesRows.length} ECB business-day rates for ${missing_dates} contract dates`,
  );
}

const now = new Date().toISOString();
const tuple = (r) =>
  `(${sqlStr(r.currency)}, ${sqlStr(r.rate_date)}, ${r.rate}, ${sqlStr(FX_SOURCE)}, ${sqlStr(now)})`;
// Chunk the INSERT: one statement with thousands of tuples trips SQLite's
// SQLITE_TOOBIG statement-length limit under `wrangler d1 execute`, so emit batches.
const CHUNK = 250;
const stmts = [];
for (let i = 0; i < rows.length; i += CHUNK) {
  const batch = rows
    .slice(i, i + CHUNK)
    .map(tuple)
    .join(',\n  ');
  if (batch)
    stmts.push(
      `INSERT OR REPLACE INTO fx_rates (base_currency, rate_date, eur_per_unit, source, fetched_at) VALUES\n  ${batch};`,
    );
}
const sql = stmts.join('\n') + '\n';
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, sql);
console.log(`\nwrote ${rows.length} rates → ${outFile}`);

if (apply && stmts.length > 0) {
  if (workDb) {
    execFileSync('sqlite3', ['-bail', String(workDb)], {
      input: readFileSync(outFile),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    console.log('applied to sqlite work DB.');
  } else {
    const persistArgs =
      remoteFlag === '--local' && persistTo ? ['--persist-to', String(persistTo)] : [];
    execFileSync(
      'wrangler',
      ['d1', 'execute', d1Name, remoteFlag, ...persistArgs, '--file', outFile],
      {
        cwd: apiDir,
        stdio: 'inherit',
      },
    );
    console.log('applied to D1.');
  }
}
