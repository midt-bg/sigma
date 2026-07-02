// Spending over time — procurement value per period (month or year) for the /trends chart. Live
// aggregation over contracts on the site-wide value basis (amount_eur IS NOT NULL, matching the rollups), within the
// 2020 -> today window; missing periods are zero-filled so the line is continuous. Contracts without a
// usable signing date are excluded from the series and reported as coverage. Edge-cached at the route,
// like getFlows; precompute is a possible follow-up.

import type {
  CpvGroupMedian,
  CpvGroupStat,
  OverviewContract,
  SectorRef,
  TrendData,
  TrendGranularity,
  TrendPoint,
  TrendYear,
} from '@sigma/api-contract';
import { CPV_SECTORS } from '@sigma/config';
import { cleanName, entityName } from '@sigma/shared';
import { contractSlug } from './identity';
import { sectorOptions } from './sectors';

export interface TrendParams {
  sector?: string | null;
  funding?: 'all' | 'eu' | 'national';
  granularity?: TrendGranularity;
  authorityId?: string | null;
  bidderId?: string | null;
}

export interface TrendQueryOptions {
  includeSectors?: boolean;
}

const START = '2020-01-01';
// A real signing year is YYYY at the head of signed_at; null/malformed dates are excluded from the
// series (and counted as undated for coverage). Mirrors the check in queries/contracts.ts.
const YEAR_KNOWN = "substr(c.signed_at, 1, 4) GLOB '[0-9][0-9][0-9][0-9]'";

interface PeriodRow {
  period: string;
  value_eur: number;
  contracts: number;
}

interface CoverageRow {
  dated: number;
  total: number;
}

// Shared value + sector/funding scope (the date window lives only on the series query).
function scope(p: TrendParams): { join: string; where: string[]; params: unknown[] } {
  // One value basis for the whole site: the rollups (authority_totals / home_totals / flow_pairs) sum
  // amount_eur IS NOT NULL, so the trend must too, or the same total differs between pages.
  const where = ['c.amount_eur IS NOT NULL'];
  const params: unknown[] = [];
  const join = p.sector || p.authorityId ? 'JOIN tenders t ON t.id = c.tender_id' : '';
  if (p.sector) {
    where.push('substr(t.cpv_code, 1, 2) = ?');
    params.push(p.sector);
  }
  if (p.authorityId) {
    where.push('t.authority_id = ?');
    params.push(p.authorityId);
  }
  if (p.bidderId) {
    where.push('c.bidder_id = ?');
    params.push(p.bidderId);
  }
  if (p.funding === 'eu') where.push('c.eu_funded = 1');
  else if (p.funding === 'national') where.push('(c.eu_funded IS NULL OR c.eu_funded = 0)');
  return { join, where, params };
}

// 'YYYY-MM' → 'YYYY-Qn'. Quarter series is queried monthly and folded here (no SQL date math).
function quarterOf(month: string): string {
  const [y, m] = month.split('-') as [string, string];
  return `${y}-Q${Math.ceil(Number(m) / 3)}`;
}

// Continuous period keys (inclusive) for zero-filling gaps, so the chart has no holes.
function fillPeriods(first: string, last: string, granularity: TrendGranularity): string[] {
  if (granularity === 'year') {
    const out: string[] = [];
    for (let y = Number(first); y <= Number(last); y += 1) out.push(String(y));
    return out;
  }
  if (granularity === 'quarter') {
    const [fy, fq] = first.split('-Q').map(Number) as [number, number];
    const [ly, lq] = last.split('-Q').map(Number) as [number, number];
    const out: string[] = [];
    for (let q = fy * 4 + (fq - 1); q <= ly * 4 + (lq - 1); q += 1) {
      out.push(`${Math.floor(q / 4)}-Q${(q % 4) + 1}`);
    }
    return out;
  }
  const [fy, fm] = first.split('-').map(Number) as [number, number];
  const [ly, lm] = last.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let m = fy * 12 + (fm - 1); m <= ly * 12 + (lm - 1); m += 1) {
    out.push(`${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`);
  }
  return out;
}

export async function getSpendingTrend(
  db: D1Database,
  p: TrendParams,
  options: TrendQueryOptions = {},
): Promise<TrendData> {
  const includeSectors = options.includeSectors ?? true;
  const granularity: TrendGranularity =
    p.granularity === 'year' || p.granularity === 'quarter' ? p.granularity : 'month';
  // Quarters are queried at month grain (substr can't cut a quarter) and folded below.
  const periodLen = granularity === 'year' ? 4 : 7; // substr length: 'YYYY' vs 'YYYY-MM'
  const s = scope(p);

  const seriesWhere = [YEAR_KNOWN, 'c.signed_at >= ?', "c.signed_at <= date('now')", ...s.where];
  const [series, coverageRow, sectors, asOfRow] = await Promise.all([
    db
      .prepare(
        `SELECT substr(c.signed_at, 1, ${periodLen}) AS period,
                COALESCE(SUM(c.amount_eur), 0) AS value_eur, COUNT(*) AS contracts
         FROM contracts c ${s.join}
         WHERE ${seriesWhere.join(' AND ')}
         GROUP BY period ORDER BY period`,
      )
      .bind(START, ...s.params)
      .all<PeriodRow>(),
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN ${YEAR_KNOWN} THEN 1 ELSE 0 END), 0) AS dated,
           COUNT(*) AS total
         FROM contracts c ${s.join} WHERE ${s.where.join(' AND ')}`,
      )
      .bind(...s.params)
      .first<CoverageRow>(),
    includeSectors ? sectorOptions(db) : Promise.resolve([]),
    db.prepare('SELECT as_of FROM home_totals WHERE id = 1').first<{ as_of: string | null }>(),
  ]);
  // The final period (the as_of period) is still being filled; mark it so the chart and table do not
  // read its dip as a real decline, and so YoY is not computed against a partial year.
  const asOf = asOfRow?.as_of ?? null;
  const asOfPeriod = asOf ? asOf.slice(0, periodLen) : null;
  const partialPeriod =
    asOfPeriod && granularity === 'quarter' ? quarterOf(asOfPeriod) : asOfPeriod;
  const partialYear = asOf ? asOf.slice(0, 4) : null;

  let rows = series.results;
  if (granularity === 'quarter' && rows.length) {
    // Fold the monthly rows into quarters (input is sorted by period, so quarters stay in order).
    const byQuarter = new Map<string, PeriodRow>();
    for (const r of rows) {
      const period = quarterOf(r.period);
      const acc = byQuarter.get(period) ?? { period, value_eur: 0, contracts: 0 };
      acc.value_eur += r.value_eur;
      acc.contracts += r.contracts;
      byQuarter.set(period, acc);
    }
    rows = [...byQuarter.values()];
  }
  let points: TrendPoint[] = [];
  if (rows.length) {
    const byPeriod = new Map(rows.map((r) => [r.period, r]));
    points = fillPeriods(rows[0]!.period, rows[rows.length - 1]!.period, granularity).map(
      (period) => {
        const r = byPeriod.get(period);
        return {
          period,
          valueEur: r?.value_eur ?? 0,
          contracts: r?.contracts ?? 0,
          partial: period === partialPeriod,
        };
      },
    );
  }

  // Per-year summary with year-over-year change (fold months into years for month granularity).
  const yearMap = new Map<string, { valueEur: number; contracts: number }>();
  for (const pt of points) {
    const y = pt.period.slice(0, 4);
    const acc = yearMap.get(y) ?? { valueEur: 0, contracts: 0 };
    acc.valueEur += pt.valueEur;
    acc.contracts += pt.contracts;
    yearMap.set(y, acc);
  }
  const sortedYears = [...yearMap.keys()].sort();
  const years: TrendYear[] = sortedYears.map((year, i) => {
    const cur = yearMap.get(year)!;
    const prev = i > 0 ? yearMap.get(sortedYears[i - 1]!)! : null;
    const partial = year === partialYear;
    return {
      year,
      valueEur: cur.valueEur,
      contracts: cur.contracts,
      // No YoY for the partial final year: a partial year against a full one reads as a false collapse.
      yoyPct:
        partial || !prev || prev.valueEur <= 0
          ? null
          : (cur.valueEur - prev.valueEur) / prev.valueEur,
      partial,
    };
  });

  const dated = coverageRow?.dated ?? 0;
  const total = coverageRow?.total ?? 0;
  return {
    granularity,
    points,
    years,
    sectors,
    totalValueEur: points.reduce((sum, pt) => sum + pt.valueEur, 0),
    coverage: { dated, total, pct: total > 0 ? dated / total : 0 },
    scope: { sector: p.sector ?? null, funding: p.funding ?? 'all', granularity },
  };
}

// ── Contracts overview: per-CPV-group price distributions + the filtered contract cards ──────────
//
// A CPV "group" is the 5-digit class prefix of tenders.cpv_code. There is no precomputed percentile
// rollup (sector_totals is per 2-digit division, count/sum only), so percentiles are computed live —
// but bounded: only the top-N groups by contract count get the full distribution, and every per-group
// scan rides idx_tenders_cpv via a half-open prefix range (cpv_code >= G AND cpv_code < succ(G)).
// The route is edge-cached, so these scans run once per cache window, not per request.

// A usable CPV group is 5 leading digits.
const CPV_GROUP_GLOB = "t.cpv_code GLOB '[0-9][0-9][0-9][0-9][0-9]*'";

/** Half-open index range covering every cpv_code with the 5-digit prefix (works for '…9' too). */
function cpvGroupRange(group: string): [string, string] {
  const hi = group.slice(0, -1) + String.fromCharCode(group.charCodeAt(group.length - 1) + 1);
  return [group, hi];
}

// One pass over a group's positive-EUR contracts (sorted by value, via the CPV index range) that
// returns only ~30 rows: the exact p10/p50/p90 ranks, a ~5%-step quantile ladder for the dot cloud,
// and the top outliers. Rank arithmetic is integer (SQLite '/' floors), mirrored in JS below.
const GROUP_DIST_SQL = `
  WITH s AS (
    SELECT c.amount_eur AS v, t.cpv_description AS name,
           ROW_NUMBER() OVER (ORDER BY c.amount_eur) AS rn,
           COUNT(*) OVER () AS cnt
    FROM contracts c JOIN tenders t ON t.id = c.tender_id
    WHERE t.cpv_code >= ? AND t.cpv_code < ? AND c.amount_eur > 0
  )
  SELECT v, name, rn, cnt FROM s
  WHERE rn = 1 OR rn = cnt
     OR rn = (cnt - 1) * 1 / 10 + 1
     OR rn = (cnt - 1) * 5 / 10 + 1
     OR rn = (cnt - 1) * 9 / 10 + 1
     OR (rn - 1) % (CASE WHEN cnt > 21 THEN (cnt - 1) / 20 ELSE 1 END) = 0
     OR rn > cnt - 5
  ORDER BY rn`;

interface GroupDistRow {
  v: number;
  name: string | null;
  rn: number;
  cnt: number;
}

/** floor-rank of quantile q among cnt sorted rows (1-based) — must match GROUP_DIST_SQL. */
const rankOf = (cnt: number, q10: number) => Math.floor(((cnt - 1) * q10) / 10) + 1;

// Most common non-empty description among the sampled rows — a representative human label for the
// group without a separate dictionary scan.
function sampleName(rows: GroupDistRow[]): string | null {
  const freq = new Map<string, number>();
  for (const r of rows) {
    const name = r.name?.trim();
    if (name) freq.set(name, (freq.get(name) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [name, n] of freq) {
    if (n > bestN) {
      best = name;
      bestN = n;
    }
  }
  return best;
}

function toGroupStat(group: string, rows: GroupDistRow[]): CpvGroupStat | null {
  if (!rows.length) return null;
  const cnt = rows[0]!.cnt;
  const at = (rank: number) => rows.find((r) => r.rn === rank)?.v ?? rows[0]!.v;
  return {
    group,
    name: sampleName(rows),
    contracts: cnt,
    medianEur: at(rankOf(cnt, 5)),
    p10Eur: at(rankOf(cnt, 1)),
    p90Eur: at(rankOf(cnt, 9)),
    maxEur: rows[rows.length - 1]!.v,
    sampleEur: rows.map((r) => r.v),
  };
}

export interface CpvGroupStatsResult {
  groups: CpvGroupStat[]; // top-N by contract count, in that order
  totalGroups: number; // distinct 5-digit groups in the corpus (the headline KPI)
}

/**
 * Top-N CPV groups by contract count, each with median / p10–p90 / max and a real-value sample for
 * the distribution row. One grouped scan for the ranking (same precedent as the live sector facet in
 * queries/contracts.ts), then one bounded indexed pass per group.
 */
export async function getCpvGroupStats(db: D1Database, limit = 10): Promise<CpvGroupStatsResult> {
  const [top, totalRow] = await Promise.all([
    db
      .prepare(
        `SELECT substr(t.cpv_code, 1, 5) AS grp, COUNT(*) AS contracts
         FROM contracts c JOIN tenders t ON t.id = c.tender_id
         WHERE c.amount_eur > 0 AND ${CPV_GROUP_GLOB}
         GROUP BY grp ORDER BY contracts DESC, grp LIMIT ?`,
      )
      .bind(limit)
      .all<{ grp: string; contracts: number }>(),
    db
      .prepare(
        `SELECT COUNT(DISTINCT substr(cpv_code, 1, 5)) AS n
         FROM tenders t WHERE ${CPV_GROUP_GLOB}`,
      )
      .first<{ n: number }>(),
  ]);

  const dists = await Promise.all(
    top.results.map((r) =>
      db
        .prepare(GROUP_DIST_SQL)
        .bind(...cpvGroupRange(r.grp))
        .all<GroupDistRow>(),
    ),
  );

  const groups = top.results
    .map((r, i) => toGroupStat(r.grp, dists[i]!.results))
    .filter((g): g is CpvGroupStat => g !== null);
  return { groups, totalGroups: totalRow?.n ?? 0 };
}

/**
 * Median (plus count and a representative name) for arbitrary CPV groups — the „спрямо типичното"
 * cohort baseline for contract cards whose group is outside the top-N stats. Bounded by the caller:
 * one indexed pass per requested group, and the card page has at most a handful of distinct groups.
 */
export async function getCpvGroupMedians(
  db: D1Database,
  groups: string[],
): Promise<CpvGroupMedian[]> {
  const unique = [...new Set(groups)].filter((g) => /^\d{5}$/.test(g));
  if (!unique.length) return [];
  const rows = await Promise.all(
    unique.map((g) =>
      db
        .prepare(
          `WITH s AS (
             SELECT c.amount_eur AS v, t.cpv_description AS name,
                    ROW_NUMBER() OVER (ORDER BY c.amount_eur) AS rn,
                    COUNT(*) OVER () AS cnt
             FROM contracts c JOIN tenders t ON t.id = c.tender_id
             WHERE t.cpv_code >= ? AND t.cpv_code < ? AND c.amount_eur > 0
           )
           SELECT v, name, cnt FROM s WHERE rn = (cnt - 1) * 5 / 10 + 1`,
        )
        .bind(...cpvGroupRange(g))
        .first<{ v: number; name: string | null; cnt: number }>(),
    ),
  );
  const out: CpvGroupMedian[] = [];
  unique.forEach((group, i) => {
    const r = rows[i];
    if (r) out.push({ group, name: r.name?.trim() || null, contracts: r.cnt, medianEur: r.v });
  });
  return out;
}

export interface OverviewContractsParams {
  year?: string | null; // 'YYYY'
  cpvGroup?: string | null; // 5-digit prefix
  sort?: 'date' | 'value';
  limit?: number;
}

interface OverviewRow {
  id: string;
  signed_at: string | null;
  amount_eur: number;
  cpv_code: string | null;
  authority_name: string;
  bidder_name: string;
  bidder_kind: 'company' | 'consortium';
}

/**
 * The shared contract cards under the overview lenses: same value/date basis as the trend series
 * (positive EUR, real signing date inside the window), optionally cut by year and/or CPV group,
 * newest-first or biggest-first. Bounded LIMIT; rides idx_contracts_signed / idx_contracts_amount_eur
 * (and idx_tenders_cpv for the group cut).
 */
export async function listOverviewContracts(
  db: D1Database,
  p: OverviewContractsParams,
): Promise<OverviewContract[]> {
  const where = ['c.amount_eur > 0', YEAR_KNOWN, 'c.signed_at >= ?', "c.signed_at <= date('now')"];
  const params: unknown[] = [START];
  if (p.year) {
    where.push('substr(c.signed_at, 1, 4) = ?');
    params.push(p.year);
  }
  if (p.cpvGroup && /^\d{5}$/.test(p.cpvGroup)) {
    where.push('t.cpv_code >= ? AND t.cpv_code < ?');
    params.push(...cpvGroupRange(p.cpvGroup));
  }
  const order =
    p.sort === 'value' ? 'ORDER BY c.amount_eur DESC, c.id' : 'ORDER BY c.signed_at DESC, c.id';
  const { results } = await db
    .prepare(
      `SELECT c.id, c.signed_at, c.amount_eur, t.cpv_code,
              a.name AS authority_name, b.name AS bidder_name, b.kind AS bidder_kind
       FROM contracts c
       JOIN tenders t ON t.id = c.tender_id
       JOIN authorities a ON a.id = t.authority_id
       JOIN bidders b ON b.id = c.bidder_id
       WHERE ${where.join(' AND ')} ${order} LIMIT ?`,
    )
    .bind(...params, p.limit ?? 24)
    .all<OverviewRow>();
  return results.map((r) => ({
    id: contractSlug(r.id),
    signedAt: r.signed_at,
    valueEur: r.amount_eur,
    authorityName: cleanName(r.authority_name),
    bidderName: entityName(cleanName(r.bidder_name), r.bidder_kind),
    cpvGroup: r.cpv_code && /^\d{5}/.test(r.cpv_code) ? r.cpv_code.slice(0, 5) : null,
  }));
}
