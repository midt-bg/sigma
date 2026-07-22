// Shared FX-rate logic (#158). Both pricing paths — the Node CLI (scripts/load-fx.mjs) and the
// Worker cron refresh (apps/etl) — convert foreign-currency contracts to EUR from ECB reference
// rates served by the no-auth api.frankfurter.app. The pure pieces (lookback, series URL, response
// validation) live here once so the two implementations cannot drift; the Worker-native loader and
// its coverage guard are D1-based and pure-fetch, safe for workerd (no Node APIs).

export const FRANKFURTER_API = 'https://api.frankfurter.app';
// ECB publishes business-day rates only; the derive SQL (scripts/refresh-slice.sql and
// scripts/normalize-raw.sql) carries the latest prior rate forward over weekends/holidays, bounded
// to this many days. Keep the three in sync.
export const FX_LOOKBACK_DAYS = 10;
export const FX_SOURCE = 'ecb:frankfurter';

export const isIsoDate = (s: unknown): boolean => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
export const isCurrencyCode = (s: unknown): boolean => /^[A-Z]{3}$/.test(String(s));

export function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

/** Frankfurter time-series URL: all business-day rates for one currency → EUR in one request. */
export function fxSeriesUrl(
  currency: string,
  startDate: string,
  endDate: string,
  api: string = FRANKFURTER_API,
): string {
  return `${api}/${encodeURIComponent(startDate)}..${encodeURIComponent(endDate)}?base=${encodeURIComponent(currency)}&symbols=${encodeURIComponent('EUR')}`;
}

export interface FxRateRow {
  currency: string;
  rateDate: string;
  eurPerUnit: number;
}

export interface FxSeriesParse {
  rows: FxRateRow[];
  warnings: string[];
}

/** Validate one frankfurter time-series payload into fx_rates rows; malformed entries are skipped
 *  with a warning, never thrown — one bad datum must not sink the rest of the series. */
export function parseFxSeries(payload: unknown, currency: string): FxSeriesParse {
  const rows: FxRateRow[] = [];
  const warnings: string[] = [];
  const rates =
    payload !== null && typeof payload === 'object'
      ? (payload as { rates?: unknown }).rates
      : undefined;
  if (rates === null || rates === undefined || typeof rates !== 'object') {
    warnings.push(`no rate series for ${currency}`);
    return { rows, warnings };
  }
  for (const [rateDate, quote] of Object.entries(rates)) {
    if (!isIsoDate(rateDate)) {
      warnings.push(`invalid rate date for ${currency}: ${rateDate}`);
      continue;
    }
    const eurPerUnit = Number((quote as { EUR?: unknown } | null)?.EUR);
    if (!Number.isFinite(eurPerUnit) || eurPerUnit <= 0) {
      warnings.push(`invalid rate for ${currency} ${rateDate}`);
      continue;
    }
    rows.push({ currency, rateDate, eurPerUnit });
  }
  return { rows, warnings };
}

export interface FxCoverageGap {
  currency: string;
  minDate: string;
  maxDate: string;
  missingDates: number;
}

interface GapRow {
  currency: string;
  min_date: string;
  max_date: string;
  missing_dates: number;
}

// Contract dates in raw staging whose currency has no usable rate: no fx_rates row within the
// FX_LOOKBACK_DAYS carry-forward window the derive SQL uses. Same corpus filter as the CLI's
// scripts/load-fx.mjs range query (EOP + OCDS sources, genuinely foreign currencies only).
const COVERAGE_GAP_SQL = `
  SELECT c.currency, MIN(c.contract_date) AS min_date, MAX(c.contract_date) AS max_date,
         COUNT(DISTINCT c.contract_date) AS missing_dates
  FROM raw_contracts c
  WHERE (c.source LIKE 'eop:%' OR c.source LIKE 'ocds:%')
    AND c.currency NOT IN ('BGN','EUR') AND c.contract_date IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM fx_rates f
      WHERE f.base_currency = c.currency
        AND f.rate_date <= c.contract_date
        AND f.rate_date >= date(c.contract_date, '-${FX_LOOKBACK_DAYS} days')
    )
  GROUP BY c.currency ORDER BY c.currency`;

export async function findFxCoverageGaps(db: D1Database): Promise<FxCoverageGap[]> {
  const { results } = await db.prepare(COVERAGE_GAP_SQL).all<GapRow>();
  return results.map((r) => ({
    currency: String(r.currency),
    minDate: String(r.min_date),
    maxDate: String(r.max_date),
    missingDates: Number(r.missing_dates),
  }));
}

export type FxFetchStatus = 'ok' | 'unsupported' | 'error';

export interface FxCurrencyLoad {
  currency: string;
  start: string;
  end: string;
  loaded: number;
  status: FxFetchStatus;
  detail?: string;
}

export interface FxLoadSummary {
  /** Per-currency fetch outcomes for the coverage gaps found before loading. */
  fetched: FxCurrencyLoad[];
  /** Staged currencies skipped without a fetch (invalid code / invalid date range). */
  skipped: string[];
  /** Total fx_rates rows upserted this run. */
  inserted: number;
  /** Coverage gaps still present after loading (unpricable by ECB data — logged, not fatal). */
  uncovered: FxCoverageGap[];
  warnings: string[];
}

/** Loading failed for rates that plausibly exist upstream — fail the run loudly (retryable)
 *  instead of letting the derive silently emit NULL amount_eur (#158). */
export class FxLoadError extends Error {
  override name = 'FxLoadError';
}

// D1 bind limit is far above 5 params/row, but mirror staging.ts: one INSERT per row, batched.
const CHUNK = 100;

async function upsertFxRates(db: D1Database, rows: FxRateRow[], fetchedAt: string): Promise<void> {
  const sql =
    'INSERT OR REPLACE INTO fx_rates (base_currency, rate_date, eur_per_unit, source, fetched_at) VALUES (?, ?, ?, ?, ?)';
  for (let i = 0; i < rows.length; i += CHUNK) {
    const statements = rows
      .slice(i, i + CHUNK)
      .map((r) => db.prepare(sql).bind(r.currency, r.rateDate, r.eurPerUnit, FX_SOURCE, fetchedAt));
    await db.batch(statements);
  }
}

export interface LoadFxOptions {
  fetchedAt: string;
  fetchFn?: typeof fetch;
  api?: string;
}

/**
 * Worker-native FX load (#158): make every staged foreign-currency contract date convertible
 * before the derive runs. Incremental and idempotent — only currencies with an actual coverage
 * gap are fetched (one time-series request each), and rows upsert into fx_rates.
 *
 * Fail-mode contract (see docs/adr/0007-worker-native-fx-load.md):
 * - already covered → no fetch, no-op;
 * - fetch fails but existing rates cover every staged date → never reached (no gap → no fetch);
 * - currency unknown to frankfurter (HTTP 404) or range outside ECB data → warn + proceed,
 *   matching the CLI's behaviour (those contracts stay NULL exactly as before);
 * - fetch/network/parse failure while a gap remains → throw FxLoadError so the Workflow step
 *   retries and the run fails loudly instead of silently deriving NULL amount_eur.
 */
export async function loadFxRates(db: D1Database, opts: LoadFxOptions): Promise<FxLoadSummary> {
  const fetchFn = opts.fetchFn ?? fetch;
  const api = opts.api ?? FRANKFURTER_API;
  const summary: FxLoadSummary = {
    fetched: [],
    skipped: [],
    inserted: 0,
    uncovered: [],
    warnings: [],
  };

  const gaps = await findFxCoverageGaps(db);
  if (gaps.length === 0) return summary;

  const failed = new Map<string, string>();
  for (const gap of gaps) {
    if (!isCurrencyCode(gap.currency)) {
      summary.skipped.push(gap.currency);
      summary.warnings.push(`invalid currency ${gap.currency}`);
      continue;
    }
    if (!isIsoDate(gap.minDate) || !isIsoDate(gap.maxDate)) {
      summary.skipped.push(gap.currency);
      summary.warnings.push(`invalid date range ${gap.currency} ${gap.minDate}..${gap.maxDate}`);
      continue;
    }
    const start = addDays(gap.minDate, -FX_LOOKBACK_DAYS);
    const end = gap.maxDate;
    const load: FxCurrencyLoad = { currency: gap.currency, start, end, loaded: 0, status: 'ok' };
    summary.fetched.push(load);
    try {
      const res = await fetchFn(fxSeriesUrl(gap.currency, start, end, api));
      if (res.status === 404) {
        // Frankfurter answers 404 for a base currency it does not serve — permanent, not
        // transient: warn and move on (CLI parity), never brick the cron on one odd currency.
        load.status = 'unsupported';
        summary.warnings.push(`currency ${gap.currency} not served by frankfurter`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { rows, warnings } = parseFxSeries(await res.json(), gap.currency);
      summary.warnings.push(...warnings);
      await upsertFxRates(db, rows, opts.fetchedAt);
      load.loaded = rows.length;
      summary.inserted += rows.length;
    } catch (error) {
      load.status = 'error';
      load.detail = error instanceof Error ? error.message : String(error);
      summary.warnings.push(`fx fetch failed for ${gap.currency} ${start}..${end}: ${load.detail}`);
      failed.set(gap.currency, load.detail);
    }
  }

  summary.uncovered = await findFxCoverageGaps(db);
  const fatal = summary.uncovered.filter((gap) => failed.has(gap.currency));
  if (fatal.length > 0) {
    throw new FxLoadError(
      `FX load failed with coverage gaps remaining: ${fatal
        .map(
          (g) =>
            `${g.currency} ${g.minDate}..${g.maxDate} (${g.missingDates} dates): ${failed.get(g.currency)}`,
        )
        .join(', ')} — refusing to derive NULL amount_eur (#158)`,
    );
  }
  return summary;
}
