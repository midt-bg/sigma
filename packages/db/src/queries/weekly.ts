// Weekly Digest (#167) — read-side queries for the digest producer. Every indicator scopes to a
// single ISO 8601 week (`strftime('%G-W%V', signed_at)`, e.g. '2024-W03') via a bound parameter. NOTE:
// wrapping `signed_at` in `strftime(...)` is NON-SARGABLE — the planner cannot use `idx_contracts_signed`
// and does a full `contracts` scan per indicator. Acceptable today: this runs cron-only (once/week), off
// the request path. FOLLOW-UP as the corpus grows: rewrite to a sargable range bound
// (`signed_at >= :monday AND signed_at < :nextMonday`) so the index applies. Money figures follow the
// site-wide clean basis (amount_eur IS NOT NULL) used by the rollups (home_totals / sector_totals /
// authority_totals) wherever the indicator sums money (a/e/g/h); b/c/d/f intentionally do not add that
// filter — see each function's comment.

import { authoritySlug, companySlug, contractSlug } from './identity';

// `strftime('%G-W%V', signed_at)` returns the ISO week for signed_at, and IS NULL when signed_at
// itself is NULL — the explicit `signed_at IS NOT NULL` just makes the "undated rows never appear
// in a weekly digest" behaviour readable without knowing that SQLite detail.
const WEEK_FILTER = `strftime('%G-W%V', c.signed_at) = ?1 AND c.signed_at IS NOT NULL`;

// ── a) Total spend ──────────────────────────────────────────────────────────────────────────────

export interface WeeklyTotal {
  totalEur: number;
}

/** Indicator a: total clean-basis spend signed within the week. */
export async function getWeeklyTotal(db: D1Database, isoWeek: string): Promise<WeeklyTotal> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(c.amount_eur), 0) AS total_eur
       FROM contracts c
       WHERE ${WEEK_FILTER} AND c.amount_eur IS NOT NULL`,
    )
    .bind(isoWeek)
    .first<{ total_eur: number }>();
  return { totalEur: row?.total_eur ?? 0 };
}

// ── b) Volume ────────────────────────────────────────────────────────────────────────────────────

export interface WeeklyCounts {
  /** Raw activity volume: every signed contract in the week, clean or not. Do NOT render this beside a
   *  money sum — it counts rows the sum excludes. The zero-row publish gate keys on this. */
  contracts: number;
  /** COUNT of the rows behind `getWeeklyTotal` (`amount_eur IS NOT NULL`). Pair a money figure with
   *  THIS, never with `contracts` — see precompute.sql's COUNT/SUM CONSISTENCY rule. */
  contractsWithAmount: number;
  tenders: number;
}

/** Indicator b: raw activity volume for the week — every signed contract counts, clean or not —
 *  plus the clean-basis count that pairs with the week's money total. */
export async function getWeeklyCounts(db: D1Database, isoWeek: string): Promise<WeeklyCounts> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS contracts,
         SUM(CASE WHEN c.amount_eur IS NOT NULL THEN 1 ELSE 0 END) AS contracts_with_amount,
         COUNT(DISTINCT c.tender_id) AS tenders
       FROM contracts c
       WHERE ${WEEK_FILTER}`,
    )
    .bind(isoWeek)
    .first<{ contracts: number; contracts_with_amount: number | null; tenders: number }>();
  return {
    contracts: row?.contracts ?? 0,
    // SUM() over zero rows is NULL, not 0.
    contractsWithAmount: row?.contracts_with_amount ?? 0,
    tenders: row?.tenders ?? 0,
  };
}

// ── c) Largest contract ─────────────────────────────────────────────────────────────────────────

export interface WeeklyLargestContract {
  contractSlug: string;
  tenderUnp: string;
  authoritySlug: string;
  bidderSlug: string;
  bidderName: string;
  amountEur: number;
  signedAt: string;
}

interface LargestRow {
  id: string;
  source_id: string;
  authority_id: string;
  bidder_id: string;
  bidder_name: string;
  amount_eur: number;
  signed_at: string;
}

/**
 * Indicator c: the single biggest contract signed in the week, guarded by `value_flag = 'ok'` so a
 * data-quality outlier (value_suspect/value_low) never becomes the digest headline. Joins only
 * tenders (for the УНП + authority id) and bidders (for the winner name) — no authorities join, the
 * digest links the authority id and lets the reader resolve the name on click-through.
 */
export async function getWeeklyLargestContract(
  db: D1Database,
  isoWeek: string,
): Promise<WeeklyLargestContract | null> {
  const row = await db
    .prepare(
      `SELECT c.id, t.source_id, t.authority_id, c.bidder_id, b.name AS bidder_name,
              c.amount_eur, c.signed_at
       FROM contracts c
       JOIN tenders t ON t.id = c.tender_id
       JOIN bidders b ON b.id = c.bidder_id
       WHERE ${WEEK_FILTER} AND c.value_flag = 'ok'
       ORDER BY c.amount_eur DESC
       LIMIT 1`,
    )
    .bind(isoWeek)
    .first<LargestRow>();
  if (!row) return null;
  return {
    contractSlug: contractSlug(row.id),
    tenderUnp: row.source_id,
    authoritySlug: authoritySlug(row.authority_id),
    bidderSlug: companySlug(row.bidder_id),
    bidderName: row.bidder_name,
    amountEur: row.amount_eur,
    signedAt: row.signed_at,
  };
}

// ── d) Single-bid rate ───────────────────────────────────────────────────────────────────────────

export interface WeeklySingleBidRate {
  rate: number | null; // null when the sample is below the reporting floor — never a misleading %
  singleBid: number;
  sample: number;
}

// Below this many reported-bid contracts, a % would swing wildly on a couple of rows — report null
// rather than a misleading figure.
const SINGLE_BID_SAMPLE_FLOOR = 20;

/** Indicator d: share of contracts awarded on a single bid, over contracts that reported a bid count. */
export async function getWeeklySingleBidRate(
  db: D1Database,
  isoWeek: string,
): Promise<WeeklySingleBidRate> {
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN c.bids_received = 1 THEN 1 ELSE 0 END) AS single_bid,
         COUNT(*) AS sample
       FROM contracts c
       WHERE ${WEEK_FILTER} AND c.bids_received >= 1`,
    )
    .bind(isoWeek)
    .first<{ single_bid: number | null; sample: number }>();
  const singleBid = row?.single_bid ?? 0;
  const sample = row?.sample ?? 0;
  return {
    rate: sample >= SINGLE_BID_SAMPLE_FLOOR ? singleBid / sample : null,
    singleBid,
    sample,
  };
}

// ── e) Week-over-week delta ─────────────────────────────────────────────────────────────────────

export interface WeeklyTotalDelta {
  isoWeek: string;
  priorIsoWeek: string;
  currentEur: number;
  priorEur: number;
  deltaEur: number;
  deltaPct: number | null; // null when the prior week had no clean spend (division by zero)
}

/**
 * Pure ISO-8601 week-date arithmetic (no `Date`-string week parsing, which JS does not provide) —
 * this is the "given isoWeek, what's the previous one" helper: locate the Monday of `isoWeek`, step
 * back 7 days, and re-derive the ISO week for that Monday. That last re-derivation is what makes
 * year-boundary weeks (…-W52/W53 ↔ …-W01) correct, since the ISO week-year is NOT always the
 * calendar year of Jan 1 — verified in weekly.test.ts against real SQLite `strftime('%G-W%V', …)`.
 */
export function priorIsoWeek(isoWeek: string): string {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!match) throw new Error(`priorIsoWeek: not an ISO week ('${isoWeek}')`);
  const isoYear = Number(match[1]);
  const week = Number(match[2]);

  const monday = isoWeekMonday(isoYear, week);
  const priorMonday = new Date(monday.getTime());
  priorMonday.setUTCDate(priorMonday.getUTCDate() - 7);

  const { isoYear: priorYear, week: priorWeek } = isoWeekOf(priorMonday);
  return `${priorYear}-W${String(priorWeek).padStart(2, '0')}`;
}

/** The Monday (UTC midnight) of ISO week `week` in ISO week-year `isoYear`. Jan 4 always falls in
 *  week 1, so week 1's Monday is Jan 4 walked back to the Monday of its calendar week. */
function isoWeekMonday(isoYear: number, week: number): Date {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7; // Sunday (0) -> 7, so Monday=1..Sunday=7
  const week1Monday = new Date(jan4.getTime());
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const monday = new Date(week1Monday.getTime());
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return monday;
}

/** ISO week-year + week number of a given UTC date, via the "nearest Thursday" standard algorithm. */
function isoWeekOf(date: Date): { isoYear: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // shift to the Thursday of this ISO week
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { isoYear, week };
}

/** Indicator e: this week's clean spend vs the prior week's — two single-week queries, diffed here. */
export async function getWeeklyTotalDelta(
  db: D1Database,
  isoWeek: string,
): Promise<WeeklyTotalDelta> {
  const prior = priorIsoWeek(isoWeek);
  const [current, priorTotal] = await Promise.all([
    getWeeklyTotal(db, isoWeek),
    getWeeklyTotal(db, prior),
  ]);
  const deltaEur = current.totalEur - priorTotal.totalEur;
  return {
    isoWeek,
    priorIsoWeek: prior,
    currentEur: current.totalEur,
    priorEur: priorTotal.totalEur,
    deltaEur,
    deltaPct: priorTotal.totalEur > 0 ? deltaEur / priorTotal.totalEur : null,
  };
}

// ── f) Top 10 contracts ─────────────────────────────────────────────────────────────────────────

export interface WeeklyTopContract {
  contractSlug: string;
  tenderUnp: string;
  subject: string;
  authorityId: string;
  authoritySlug: string;
  authorityName: string;
  bidderId: string;
  bidderSlug: string;
  bidderName: string;
  amountEur: number;
  signedAt: string;
}

interface TopContractRow {
  id: string;
  source_id: string;
  title: string;
  authority_id: string;
  authority_name: string;
  bidder_id: string;
  bidder_name: string;
  amount_eur: number;
  signed_at: string;
}

/** Indicator f: the week's 10 biggest contracts, `value_flag = 'ok'` guarded like indicator c. Entity
 *  ids (authorityId/bidderId, for joins/analytics) are kept separate from the slugs + display text
 *  (for links/rendering). */
export async function getWeeklyTopContracts(
  db: D1Database,
  isoWeek: string,
): Promise<WeeklyTopContract[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, t.source_id, t.title, t.authority_id, a.name AS authority_name,
              c.bidder_id, b.name AS bidder_name, c.amount_eur, c.signed_at
       FROM contracts c
       JOIN tenders t ON t.id = c.tender_id
       JOIN bidders b ON b.id = c.bidder_id
       JOIN authorities a ON a.id = t.authority_id
       WHERE ${WEEK_FILTER} AND c.value_flag = 'ok'
       ORDER BY c.amount_eur DESC
       LIMIT 10`,
    )
    .bind(isoWeek)
    .all<TopContractRow>();
  return results.map((r) => ({
    contractSlug: contractSlug(r.id),
    tenderUnp: r.source_id,
    subject: r.title,
    authorityId: r.authority_id,
    authoritySlug: authoritySlug(r.authority_id),
    authorityName: r.authority_name,
    bidderId: r.bidder_id,
    bidderSlug: companySlug(r.bidder_id),
    bidderName: r.bidder_name,
    amountEur: r.amount_eur,
    signedAt: r.signed_at,
  }));
}

// ── g) Sector breakdown ─────────────────────────────────────────────────────────────────────────

export interface WeeklySectorSlice {
  division: string; // 2-digit CPV division
  contracts: number;
  valueEur: number;
}

/** Indicator g: clean-basis spend for the week, grouped by 2-digit CPV division (`cpv_code` lives on
 *  `tenders`, hence the join). */
export async function getWeeklySectorBreakdown(
  db: D1Database,
  isoWeek: string,
): Promise<WeeklySectorSlice[]> {
  const { results } = await db
    .prepare(
      `SELECT substr(t.cpv_code, 1, 2) AS division, COUNT(*) AS contracts,
              SUM(c.amount_eur) AS value_eur
       FROM contracts c
       JOIN tenders t ON t.id = c.tender_id
       WHERE ${WEEK_FILTER} AND c.amount_eur IS NOT NULL
       GROUP BY division
       ORDER BY value_eur DESC`,
    )
    .bind(isoWeek)
    .all<{ division: string | null; contracts: number; value_eur: number }>();
  return results
    .filter((r): r is { division: string; contracts: number; value_eur: number } =>
      Boolean(r.division),
    )
    .map((r) => ({ division: r.division, contracts: r.contracts, valueEur: r.value_eur }));
}

// ── h) Authority breakdown ──────────────────────────────────────────────────────────────────────

export interface WeeklyAuthoritySlice {
  authorityId: string;
  authoritySlug: string;
  authorityName: string;
  contracts: number;
  valueEur: number;
}

/** Indicator h: top-10 authorities by clean-basis spend for the week (`authority_id` lives on
 *  `tenders`, hence the join). */
export async function getWeeklyAuthorityBreakdown(
  db: D1Database,
  isoWeek: string,
): Promise<WeeklyAuthoritySlice[]> {
  const { results } = await db
    .prepare(
      `SELECT t.authority_id, a.name AS authority_name, COUNT(*) AS contracts,
              SUM(c.amount_eur) AS value_eur
       FROM contracts c
       JOIN tenders t ON t.id = c.tender_id
       JOIN authorities a ON a.id = t.authority_id
       WHERE ${WEEK_FILTER} AND c.amount_eur IS NOT NULL
       GROUP BY t.authority_id
       ORDER BY value_eur DESC
       LIMIT 10`,
    )
    .bind(isoWeek)
    .all<{ authority_id: string; authority_name: string; contracts: number; value_eur: number }>();
  return results.map((r) => ({
    authorityId: r.authority_id,
    authoritySlug: authoritySlug(r.authority_id),
    authorityName: r.authority_name,
    contracts: r.contracts,
    valueEur: r.value_eur,
  }));
}

// ── Daily spend (for the weekly bar chart, spec §3.4) ────────────────────────────────────────────

export interface WeeklyDaySpend {
  dateIso: string; // 'YYYY-MM-DD' (the day within the week)
  label: string; // Bulgarian short day name, Пн..Нд
  valueEur: number; // clean-basis spend signed that day (0 for a day with no clean contracts)
}

export interface WeeklyDailySpend {
  current: WeeklyDaySpend[]; // 7 slots, Monday..Sunday of `isoWeek`
  previous: WeeklyDaySpend[]; // 7 slots, Monday..Sunday of the prior week (the „ghost" bars)
}

const DAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'] as const;

/** The 7 ISO dates (Mon..Sun) of an ISO week — reuses isoWeekMonday so year-boundary weeks are correct. */
function weekDates(isoWeek: string): string[] {
  const m = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!m) throw new Error(`weekDates: not an ISO week ('${isoWeek}')`);
  const monday = isoWeekMonday(Number(m[1]), Number(m[2]));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday.getTime());
    d.setUTCDate(monday.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

/**
 * Per-day clean-basis spend for one week, projected onto a fixed Mon..Sun 7-slot array (zero-filled).
 *
 * Date alignment (#81 review, note 2): `substr(c.signed_at, 1, 10)` takes the calendar-date prefix of
 * `signed_at`, and `weekDates()` enumerates the same week's dates from `isoWeekMonday` in UTC. This is
 * consistent because `signed_at` is stored as a UTC date-prefixed string — the SAME basis the
 * whole-file `WEEK_FILTER` (`strftime('%G-W%V', c.signed_at)`) already relies on to bucket a row into a
 * week. Both the substring day-key and the UTC slot boundaries read that one calendar date, so a
 * midnight edge cannot split a row from its slot.
 */
async function daySpendFor(db: D1Database, isoWeek: string): Promise<WeeklyDaySpend[]> {
  const dates = weekDates(isoWeek);
  const { results } = await db
    .prepare(
      `SELECT substr(c.signed_at, 1, 10) AS day, SUM(c.amount_eur) AS value_eur
       FROM contracts c
       WHERE ${WEEK_FILTER} AND c.amount_eur IS NOT NULL
       GROUP BY day`,
    )
    .bind(isoWeek)
    .all<{ day: string; value_eur: number }>();
  const byDay = new Map(results.map((r) => [r.day, r.value_eur]));
  return dates.map((dateIso, i) => ({
    dateIso,
    label: DAY_LABELS[i]!,
    valueEur: byDay.get(dateIso) ?? 0,
  }));
}

/** Daily spend for the week and the prior week, day-of-week aligned — feeds the ghost-bar chart (§3.4). */
export async function getWeeklyDailySpend(
  db: D1Database,
  isoWeek: string,
): Promise<WeeklyDailySpend> {
  const prior = priorIsoWeek(isoWeek);
  const [current, previous] = await Promise.all([daySpendFor(db, isoWeek), daySpendFor(db, prior)]);
  return { current, previous };
}

// ── Aggregate + reconciliation ──────────────────────────────────────────────────────────────────

export interface WeeklyDigestData {
  isoWeek: string;
  total: WeeklyTotal;
  counts: WeeklyCounts;
  largest: WeeklyLargestContract | null;
  singleBidRate: WeeklySingleBidRate;
  delta: WeeklyTotalDelta;
  topContracts: WeeklyTopContract[];
  sectors: WeeklySectorSlice[];
  authorities: WeeklyAuthoritySlice[];
  dailySpend: WeeklyDailySpend;
}

/** All indicators for one ISO week, fetched concurrently. */
export async function getWeeklyDigestData(
  db: D1Database,
  isoWeek: string,
): Promise<WeeklyDigestData> {
  const [
    total,
    counts,
    largest,
    singleBidRate,
    delta,
    topContracts,
    sectors,
    authorities,
    dailySpend,
  ] = await Promise.all([
    getWeeklyTotal(db, isoWeek),
    getWeeklyCounts(db, isoWeek),
    getWeeklyLargestContract(db, isoWeek),
    getWeeklySingleBidRate(db, isoWeek),
    getWeeklyTotalDelta(db, isoWeek),
    getWeeklyTopContracts(db, isoWeek),
    getWeeklySectorBreakdown(db, isoWeek),
    getWeeklyAuthorityBreakdown(db, isoWeek),
    getWeeklyDailySpend(db, isoWeek),
  ]);
  return {
    isoWeek,
    total,
    counts,
    largest,
    singleBidRate,
    delta,
    topContracts,
    sectors,
    authorities,
    dailySpend,
  };
}

export interface WeeklyReconciliation {
  isoWeek: string;
  weekEur: number;
  homeTotalEur: number;
  withinBounds: boolean;
}

/**
 * Log-only sanity check: a single week's clean spend can never exceed the all-time `home_totals`
 * total (both sum the same `amount_eur IS NOT NULL` basis, so they're directly comparable) — unlike
 * `contracts`, whose corpus count does NOT cover the same set as `value_eur` (see home_totals'
 * schema comment). Never throws; the producer logs the anomaly and ships the digest regardless, since
 * a reconciliation mismatch means the rollup is stale, not that the week's own numbers are wrong.
 */
export async function reconcileWeeklyTotal(
  db: D1Database,
  isoWeek: string,
): Promise<WeeklyReconciliation> {
  const [{ totalEur }, homeRow] = await Promise.all([
    getWeeklyTotal(db, isoWeek),
    db.prepare(`SELECT value_eur FROM home_totals WHERE id = 1`).first<{ value_eur: number }>(),
  ]);
  const homeTotalEur = homeRow?.value_eur ?? 0;
  const withinBounds = totalEur <= homeTotalEur;
  if (!withinBounds) {
    // eslint-disable-next-line no-console -- deliberate, low-volume (once/week) operational signal
    console.warn(
      `[weekly-digest] reconciliation mismatch for ${isoWeek}: week value_eur=${totalEur} > home_totals.value_eur=${homeTotalEur}`,
    );
  }
  return { isoWeek, weekEur: totalEur, homeTotalEur, withinBounds };
}
