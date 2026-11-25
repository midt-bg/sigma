// Shared FX-rate logic (#158). Both pricing paths — the Node CLI (scripts/load-fx.mjs) and the
// Worker cron refresh (apps/etl) — convert foreign-currency contracts to EUR from ECB reference
// rates served by the no-auth frankfurter API. The pure pieces (lookback, series URL, response
// validation) live here once so the two implementations cannot drift; the Worker-native loader and
// its coverage guard are D1-based and pure-fetch, safe for workerd (no Node APIs).

// A response body that is never read keeps its stream - and the connection behind it - open for the
// rest of the invocation; the collector is not a substitute. Every path that walks away from a
// response without reading it - a blocked redirect, a missing bucket, any non-OK status - releases it
// here. Deliberately NOT awaited: cancelling only needs to be INITIATED for the runtime to release the
// stream, and awaiting it would make the caller hostage to a cancel() that never settles.
export function discardBody(res: Response): void {
  try {
    void res.body?.cancel().catch(() => {});
  } catch {
    // Already consumed, locked, or errored - there is nothing left to release either way.
  }
}

// Canonical host. The legacy api.frankfurter.app now 301-redirects here — with host-pinned
// fetches (assertSameFinalHost) the legacy host would fail closed, so point at the target
// directly. Same response shape; the /v1 prefix is required on the .dev host.
export const FRANKFURTER_API = 'https://api.frankfurter.dev/v1';
// ECB publishes business-day rates only; the valuation SQL in work-staging-schema.sql carries
// the latest prior rate forward over weekends and holidays, bounded to this many days.
export const FX_LOOKBACK_DAYS = 10;
export const FX_SOURCE = 'ecb:frankfurter';

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const isCurrencyCode = (s: unknown): boolean => /^[A-Z]{3}$/.test(String(s));

export function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

/** Reject cross-host redirects on a host-pinned fetch (`what` names it in the error: FX rates,
 *  EOP buckets): a redirected response must never feed rates into fx_rates or rows into staging. */
export function assertSameFinalHost(requestUrl: string, responseUrl: string, what = 'FX'): void {
  const requested = new URL(requestUrl);
  const final = new URL(responseUrl || requestUrl);
  if (final.host !== requested.host) {
    throw new Error(`blocked redirected ${what} fetch from ${requested.host} to ${final.host}`);
  }
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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface FxSeriesRequest {
  base: string;
  quote: 'EUR';
  amount: 1;
  start: string;
  end: string;
}

/** Parse the Frankfurter v1 date-to-quote map (https://frankfurter.dev/v1/).
 *  Validate the entire currency series before any rows are written. An empty map is valid. */
export function parseFxSeries(payload: unknown, request: FxSeriesRequest): FxRateRow[] {
  const label = `${request.base} ${request.start}..${request.end}`;
  if (!isJsonObject(payload) || !isJsonObject(payload.rates)) {
    throw new Error(`malformed FX series for ${label}: expected a rate map`);
  }
  const { base, start_date, end_date, amount, rates } = payload;
  const dates = Object.keys(rates).sort();
  const first = dates[0];
  const last = dates.at(-1);
  if (
    (base !== undefined && base !== request.base) ||
    (amount !== undefined && amount !== request.amount) ||
    (start_date !== undefined && !isIsoDate(start_date)) ||
    (end_date !== undefined && (!isIsoDate(end_date) || end_date > request.end)) ||
    (typeof start_date === 'string' && typeof end_date === 'string' && start_date > end_date) ||
    (first !== undefined &&
      (base !== request.base ||
        amount !== request.amount ||
        start_date !== first ||
        end_date !== last))
  ) {
    throw new Error(`malformed FX series for ${label}: invalid series metadata`);
  }
  // V1 returns the actual first and last observation as its bounds. The range query includes
  // at most one preceding observation when the lower boundary has no business-day quote.
  return dates.map((rateDate, index) => {
    if (!isIsoDate(rateDate)) {
      throw new Error(`malformed FX series for ${label}: invalid rate date ${rateDate}`);
    }
    if (index > 0 && rateDate <= request.start) {
      throw new Error(`malformed FX series for ${label}: out-of-range observation ${rateDate}`);
    }
    const quote = rates[rateDate];
    const quoteMap = isJsonObject(quote) ? quote : {};
    const eurPerUnit = quoteMap[request.quote];
    if (
      typeof eurPerUnit !== 'number' ||
      !Number.isFinite(eurPerUnit) ||
      eurPerUnit <= 0 ||
      Object.keys(quoteMap).length !== 1
    ) {
      throw new Error(`malformed FX series for ${label}: invalid EUR rate on ${rateDate}`);
    }
    return { currency: request.base, rateDate, eurPerUnit };
  });
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

// The raw keys are final after annex resolution. A slice also has the affected cumulative
// history in raw_contract_value_annexes. Full imports use the resolved raw publications.
const FX_CONTRACT_DATES_SQL = `
  WITH affected AS MATERIALIZED (
    SELECT unp, contract_number FROM raw_contract_value_scope
    UNION
    SELECT unp, contract_number FROM raw_amendments
    WHERE unp IS NOT NULL AND contract_number IS NOT NULL
  ), served AS MATERIALIZED (
    SELECT k.unp, k.contract_number, c.currency, c.signed_at AS contract_date,
      c.own_estimate_value, c.own_estimate_currency
    FROM affected k
    CROSS JOIN contracts c ON c.tender_id = 't:' || k.unp AND c.contract_number = k.contract_number
    WHERE c.signed_at IS NOT NULL
  ), staged AS MATERIALIZED (
    SELECT unp, contract_number, currency, contract_date, estimated_value, procurement_currency
    FROM raw_contracts
    WHERE (source LIKE 'eop:%' OR source LIKE 'ocds:%') AND contract_date IS NOT NULL
  ), dates AS MATERIALIZED (
    SELECT unp, contract_number, contract_date FROM staged
    UNION
    SELECT unp, contract_number, contract_date FROM served
  ), contract_currencies AS (
    SELECT currency, contract_date FROM staged
    UNION ALL
    SELECT currency, contract_date FROM served
    UNION ALL
    SELECT COALESCE(NULLIF(procurement_currency, ''), currency), contract_date
    FROM staged WHERE estimated_value IS NOT NULL
    UNION ALL
    SELECT COALESCE(NULLIF(own_estimate_currency, ''), currency), contract_date
    FROM served WHERE own_estimate_value IS NOT NULL
  ), procedure_currencies AS (
    SELECT t.currency, d.contract_date
    FROM dates d JOIN raw_tenders t ON t.unp = d.unp
    WHERE t.lot_id IS NULL AND t.estimated_value IS NOT NULL
    UNION ALL
    SELECT t.currency, d.contract_date
    FROM dates d JOIN tenders t ON t.id = 't:' || d.unp
    WHERE t.estimated_value IS NOT NULL
  ), annex_currencies AS (
    SELECT a.currency, d.contract_date
    FROM dates d JOIN raw_amendments a ON a.unp = d.unp AND a.contract_number = d.contract_number
    WHERE COALESCE(a.value_after_restated, a.value_after) IS NOT NULL
    UNION ALL
    SELECT a.currency, d.contract_date
    FROM dates d JOIN raw_contract_value_annexes a ON a.unp = d.unp AND a.contract_number = d.contract_number
    WHERE a.effective_after IS NOT NULL
  )
  SELECT currency, contract_date FROM (
    SELECT * FROM contract_currencies
    UNION ALL
    SELECT * FROM procedure_currencies
    UNION ALL
    SELECT * FROM annex_currencies
  ) WHERE currency NOT IN ('', 'BGN', 'EUR')`;

// Coverage uses the same signing-date lookback as valuation. A metadata-only slice can still
// need a quote for a previously published annex or estimate.
export const FX_COVERAGE_GAP_SQL = `
  SELECT c.currency, MIN(c.contract_date) AS min_date, MAX(c.contract_date) AS max_date,
         COUNT(DISTINCT c.contract_date) AS missing_dates
  FROM (${FX_CONTRACT_DATES_SQL}) c
  WHERE NOT EXISTS (
      SELECT 1 FROM fx_rates f
      WHERE f.base_currency = c.currency
        AND f.rate_date <= c.contract_date
        AND f.rate_date >= date(c.contract_date, '-${FX_LOOKBACK_DAYS} days')
    )
  GROUP BY c.currency ORDER BY c.currency`;

export async function findFxCoverageGaps(db: D1Database): Promise<FxCoverageGap[]> {
  const { results } = await db.prepare(FX_COVERAGE_GAP_SQL).all<GapRow>();
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
 * Fail-mode contract (see docs/adr/0029-worker-native-fx-load.md):
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
      const url = fxSeriesUrl(gap.currency, start, end, api);
      const res = await fetchFn(url);
      try {
        assertSameFinalHost(url, res.url);
      } catch (err) {
        discardBody(res);
        throw err;
      }
      if (res.status === 404) {
        // Frankfurter answers 404 for a base currency it does not serve — permanent, not
        // transient: warn and move on (CLI parity), never brick the cron on one odd currency.
        // The body still has to be released — this `continue` is the most-travelled path here.
        discardBody(res);
        load.status = 'unsupported';
        summary.warnings.push(`currency ${gap.currency} not served by frankfurter`);
        continue;
      }
      if (!res.ok) {
        discardBody(res);
        throw new Error(`HTTP ${res.status}`);
      }
      const rows = parseFxSeries(await res.json(), {
        base: gap.currency,
        quote: 'EUR',
        amount: 1,
        start,
        end,
      });
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
