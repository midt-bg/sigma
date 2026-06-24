// Spending over time — procurement value per period (month or year) for the /trends chart. Live
// aggregation over contracts on the site-wide value basis (amount_eur IS NOT NULL, matching the rollups), within the
// 2020 -> today window; missing periods are zero-filled so the line is continuous. Contracts without a
// usable signing date are excluded from the series and reported as coverage. Edge-cached at the route,
// like getFlows; precompute is a possible follow-up.

import type { SectorRef, TrendData, TrendPoint, TrendYear } from '@sigma/api-contract';
import { CPV_SECTORS } from '@sigma/config';

export interface TrendParams {
  sector?: string | null;
  funding?: 'all' | 'eu' | 'national';
  granularity?: 'month' | 'year';
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

// Continuous period keys (inclusive) for zero-filling gaps, so the chart has no holes.
function fillPeriods(first: string, last: string, granularity: 'month' | 'year'): string[] {
  if (granularity === 'year') {
    const out: string[] = [];
    for (let y = Number(first); y <= Number(last); y += 1) out.push(String(y));
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

const SECTOR_OPTION_LIMIT = 12;

// Sector select options: present sectors by value (curated label), capped. Same source as getFlows.
async function sectorOptions(db: D1Database): Promise<SectorRef[]> {
  const { results } = await db
    .prepare(`SELECT division FROM sector_totals ORDER BY value_eur DESC LIMIT ?`)
    .bind(SECTOR_OPTION_LIMIT)
    .all<{ division: string }>();
  const byCode = new Map(CPV_SECTORS.map((s) => [s.code, s]));
  return results
    .map((r) => byCode.get(r.division))
    .filter((s): s is (typeof CPV_SECTORS)[number] => Boolean(s))
    .map((s) => ({ code: s.code, label: s.short ?? s.label, short: s.short ?? s.label }));
}

export async function getSpendingTrend(
  db: D1Database,
  p: TrendParams,
  options: TrendQueryOptions = {},
): Promise<TrendData> {
  const includeSectors = options.includeSectors ?? true;
  const granularity = p.granularity === 'year' ? 'year' : 'month';
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
  const partialPeriod = asOf ? asOf.slice(0, periodLen) : null;
  const partialYear = asOf ? asOf.slice(0, 4) : null;

  const rows = series.results;
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
