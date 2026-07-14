// Anomalies — the automated red-flag screen. The list reads the precomputed `contract_anomalies`
// table (built by scripts/precompute.sql §7, scoped-refreshed daily) and joins the domain tables
// only for the 15 displayed rows; every filter/sort/summary predicate stays on the small anomaly
// table. Signals are indicators for public scrutiny, never verdicts — see /methodology.

import type {
  AnomaliesSummary,
  AnomalyFacets,
  AnomalyListItem,
  AnomalySignals,
  FacetCount,
  Page,
} from '@sigma/api-contract';
import { ANOMALY_SIGNALS, CPV_SECTORS } from '@sigma/config';
import { cleanName, entityName } from '@sigma/shared';
import { authoritySlug, bidderIdFromSlug, companySlug, contractSlug } from './identity';
import { filterSignature, keyset, pageCursors } from './keyset';
import { lookup } from './lookup';

export type AnomalySort = 'score-desc' | 'value-desc' | 'value-asc' | 'date-desc' | 'date-asc';

export interface AnomalyListParams {
  sort?: AnomalySort;
  signals?: string[];
  years?: string[];
  sectors?: string[];
  valueBucket?: string | null;
  authority?: string | null; // authority ЕИК (slug)
  bidder?: string | null; // bidder slug
  cursor?: string | null;
  pageSize?: number;
}

export const ANOMALY_FILTER_KEYS = [
  'signals',
  'years',
  'sectors',
  'valueBucket',
  'authority',
  'bidder',
] as const satisfies readonly (keyof AnomalyListParams)[];

// rank_value = score×1e12 + amount_eur (precomputed) — score-major, value-minor, so equal scores
// surface the big money first without a composite keyset cursor.
const SORTS: Record<AnomalySort, { expr: string; dir: 'asc' | 'desc' }> = lookup({
  'score-desc': { expr: 'an.rank_value', dir: 'desc' },
  'value-desc': { expr: 'COALESCE(an.amount_eur, -1)', dir: 'desc' },
  'value-asc': { expr: 'COALESCE(an.amount_eur, 1e18)', dir: 'asc' },
  'date-desc': { expr: "COALESCE(an.signed_at, '')", dir: 'desc' },
  'date-asc': { expr: "COALESCE(an.signed_at, '9999-99')", dir: 'asc' },
});

// Signal filter key → the authoritative trigger column (thresholds are baked into the flags at
// precompute time, so the WHERE never re-states them).
const SIGNAL_COLUMNS: Record<string, string> = lookup({
  over_estimate: 'an.flag_over_estimate',
  annex_growth: 'an.flag_annex_growth',
  price_outlier: 'an.flag_price_outlier',
  single_bid: 'an.flag_single_bid',
  no_notice: 'an.flag_no_notice',
});

const VALUE_BUCKETS: Record<string, [number, number | null]> = lookup({
  lt100k: [0, 100_000],
  '100k-1m': [100_000, 1_000_000],
  '1m-10m': [1_000_000, 10_000_000],
  '10m-100m': [10_000_000, 100_000_000],
  gt100m: [100_000_000, null],
});

const qs = (n: number) => Array.from({ length: n }, () => '?').join(', ');

interface AnomalyRow {
  id: string;
  subject: string;
  unp: string;
  cpv_division: string | null;
  signed_at: string | null;
  amount_eur: number;
  score: number;
  flag_over_estimate: number;
  over_estimate_ratio: number | null;
  estimated_eur: number | null;
  flag_annex_growth: number;
  annex_growth_ratio: number | null;
  flag_price_outlier: number;
  price_ratio: number | null;
  peer_median_eur: number | null;
  peer_count: number | null;
  flag_single_bid: number;
  flag_no_notice: number;
  authority_id: string;
  authority_name: string;
  bidder_id: string;
  bidder_name: string;
  bidder_kind: 'company' | 'consortium';
}

const SELECT = `
  SELECT an.contract_id AS id, COALESCE(NULLIF(c.contract_subject, ''), t.title) AS subject,
         t.source_id AS unp, an.cpv_division, an.signed_at, an.amount_eur, an.score,
         an.flag_over_estimate, an.over_estimate_ratio, an.estimated_eur,
         an.flag_annex_growth, an.annex_growth_ratio,
         an.flag_price_outlier, an.price_ratio, an.peer_median_eur, an.peer_count,
         an.flag_single_bid, an.flag_no_notice,
         an.authority_id, a.name AS authority_name,
         an.bidder_id, b.name AS bidder_name, b.kind AS bidder_kind`;
const FROM = `
  FROM contract_anomalies an
  JOIN contracts c ON c.id = an.contract_id
  JOIN tenders t ON t.id = c.tender_id
  JOIN authorities a ON a.id = an.authority_id
  JOIN bidders b ON b.id = an.bidder_id`;
// Summary/facet aggregates never need the display joins.
const FROM_BARE = ` FROM contract_anomalies an`;

/**
 * Build the WHERE fragment (with a leading ' WHERE ') + params shared by list and summary. Every
 * predicate targets `an.*` so aggregates ride the small table. Keep consumed filter keys in sync
 * with ANOMALY_FILTER_KEYS and anomalyFilterSignature().
 */
function buildFilters(p: AnomalyListParams): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (p.signals?.length) {
    const cols = p.signals.map((s) => SIGNAL_COLUMNS[s]).filter((c): c is string => Boolean(c));
    if (cols.length) where.push(`(${cols.map((c) => `${c} = 1`).join(' OR ')})`);
    else where.push('1=0'); // only unknown signal keys → empty result, not an unfiltered list
  }
  if (p.years?.length) {
    where.push(`substr(an.signed_at, 1, 4) IN (${qs(p.years.length)})`);
    params.push(...p.years);
  }
  if (p.sectors?.length) {
    where.push(`an.cpv_division IN (${qs(p.sectors.length)})`);
    params.push(...p.sectors);
  }
  const bucket = p.valueBucket ? VALUE_BUCKETS[p.valueBucket] : undefined;
  if (bucket) {
    const [lo, hi] = bucket;
    where.push(hi == null ? `an.amount_eur >= ?` : `(an.amount_eur >= ? AND an.amount_eur < ?)`);
    params.push(lo);
    if (hi != null) params.push(hi);
  }
  if (p.authority) {
    where.push(`an.authority_id = ?`);
    params.push('auth:' + p.authority);
  }
  if (p.bidder) {
    const id = bidderIdFromSlug(p.bidder);
    if (id) {
      where.push(`an.bidder_id = ?`);
      params.push(id);
    } else {
      where.push('1=0');
    }
  }
  return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

function anomalyFilterSignature(p: AnomalyListParams): string {
  const bidder = p.bidder ? (bidderIdFromSlug(p.bidder) ?? `invalid:${p.bidder}`) : null;
  const filters = {
    signals: p.signals,
    years: p.years,
    sectors: p.sectors,
    valueBucket: p.valueBucket,
    authority: p.authority,
    bidder,
  } satisfies Record<(typeof ANOMALY_FILTER_KEYS)[number], unknown>;
  return filterSignature(filters);
}

function toItem(r: AnomalyRow): AnomalyListItem {
  const authorityName = cleanName(r.authority_name);
  const bidderName = cleanName(r.bidder_name);
  // Ratios surface only when the corresponding flag fired, so the UI can render one badge per
  // non-null field without re-stating thresholds.
  const signals: AnomalySignals = {
    overEstimateRatio: r.flag_over_estimate === 1 ? r.over_estimate_ratio : null,
    estimatedEur: r.flag_over_estimate === 1 ? r.estimated_eur : null,
    annexGrowthRatio: r.flag_annex_growth === 1 ? r.annex_growth_ratio : null,
    priceRatio: r.flag_price_outlier === 1 ? r.price_ratio : null,
    peerMedianEur: r.flag_price_outlier === 1 ? r.peer_median_eur : null,
    peerCount: r.flag_price_outlier === 1 ? r.peer_count : null,
    singleBid: r.flag_single_bid === 1,
    noNotice: r.flag_no_notice === 1,
  };
  return {
    id: contractSlug(r.id),
    subject: r.subject,
    unp: r.unp,
    sectorCode: r.cpv_division,
    authoritySlug: authoritySlug(r.authority_id),
    authorityName,
    bidderSlug: companySlug(r.bidder_id),
    bidderName,
    bidderDisplayName: entityName(bidderName, r.bidder_kind),
    bidderKind: r.bidder_kind,
    isConsortium: r.bidder_kind === 'consortium',
    signedAt: r.signed_at,
    valueEur: r.amount_eur,
    score: r.score,
    signals,
  };
}

export interface AnomalyListResult extends Page<AnomalyListItem> {
  valueEur: number;
}

export async function listAnomalies(
  db: D1Database,
  p: AnomalyListParams,
): Promise<AnomalyListResult> {
  const sort = SORTS[p.sort as keyof typeof SORTS] ?? SORTS['score-desc'];
  const pageSize = p.pageSize ?? 15;
  const filters = buildFilters(p);
  const signature = anomalyFilterSignature(p);
  const ks = keyset({
    sortCol: sort.expr,
    idCol: 'an.contract_id',
    dir: sort.dir,
    cursor: p.cursor,
    filterSignature: signature,
    allowedSortCols: Object.values(SORTS).map((s) => s.expr),
  });

  const conds = [filters.sql ? filters.sql.slice(7) : '', ks.whereSql]
    .filter(Boolean)
    .join(' AND ');
  const sql = `${SELECT}, ${sort.expr} AS sort_value ${FROM}${conds ? ' WHERE ' + conds : ''} ${ks.orderSql} LIMIT ?`;
  // The page and its headline are independent — one round-trip instead of two sequential ones.
  const [{ results }, summary] = await Promise.all([
    db
      .prepare(sql)
      .bind(...filters.params, ...ks.params, pageSize + 1)
      .all<AnomalyRow & { sort_value: string | number }>(),
    anomaliesSummary(db, p),
  ]);

  const hasMore = results.length > pageSize;
  let rows = results.slice(0, pageSize);
  if (ks.reverse) rows = rows.reverse();

  const cursors = pageCursors({
    rows: rows.map((r) => ({ sortValue: r.sort_value, id: r.id })),
    hasMore,
    incomingCursor: p.cursor,
    cursor: ks.cursor,
    sortToken: ks.cursorToken,
  });

  return {
    items: rows.map(toItem),
    total: summary.total,
    valueEur: summary.valueEur,
    nextCursor: cursors.nextCursor,
    prevCursor: cursors.prevCursor,
  };
}

/** Row count + flagged value for the current filter (the list headline). */
export async function anomaliesSummary(
  db: D1Database,
  p: AnomalyListParams,
): Promise<AnomaliesSummary> {
  const filters = buildFilters(p);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(an.amount_eur), 0) AS eur${FROM_BARE}${filters.sql}`,
    )
    .bind(...filters.params)
    .first<{ total: number; eur: number }>();
  return { total: row?.total ?? 0, valueEur: row?.eur ?? 0 };
}

/**
 * Rail facets — global (unfiltered) counts over contract_anomalies, mirroring the contracts rail.
 * Signals keep the ANOMALY_SIGNALS display order; sectors/years render only non-empty buckets
 * (rows without a parseable year simply match no year filter).
 */
export async function getAnomalyFacets(db: D1Database): Promise<AnomalyFacets> {
  const [signalRow, sectorRows, yearRows] = await Promise.all([
    db
      .prepare(
        `SELECT SUM(flag_over_estimate) AS over_estimate, SUM(flag_annex_growth) AS annex_growth,
                SUM(flag_price_outlier) AS price_outlier, SUM(flag_single_bid) AS single_bid,
                SUM(flag_no_notice) AS no_notice${FROM_BARE}`,
      )
      .first<Record<string, number | null>>(),
    db
      .prepare(
        `SELECT cpv_division AS key, COUNT(*) AS contracts${FROM_BARE}
         WHERE cpv_division IS NOT NULL GROUP BY cpv_division`,
      )
      .all<{ key: string; contracts: number }>(),
    db
      .prepare(
        `SELECT substr(an.signed_at, 1, 4) AS key, COUNT(*) AS contracts${FROM_BARE}
         WHERE substr(an.signed_at, 1, 4) GLOB '[0-9][0-9][0-9][0-9]' GROUP BY key`,
      )
      .all<{ key: string; contracts: number }>(),
  ]);

  const signals: FacetCount[] = ANOMALY_SIGNALS.map((s) => ({
    value: s.key,
    label: s.label,
    count: Number(signalRow?.[s.key] ?? 0),
  })).filter((f) => f.count > 0);

  const sectorByCode = new Map(sectorRows.results.map((r) => [r.key, r.contracts]));
  const sectors: FacetCount[] = CPV_SECTORS.map((s) => ({
    value: s.code,
    label: s.short ?? s.label,
    count: sectorByCode.get(s.code) ?? 0,
  }))
    .filter((f) => f.count > 0)
    .sort((a, b) => b.count - a.count);

  const years: FacetCount[] = yearRows.results
    .sort((a, b) => b.key.localeCompare(a.key))
    .map((r) => ({ value: r.key, label: r.key, count: r.contracts }));

  return { signals, sectors, years };
}
