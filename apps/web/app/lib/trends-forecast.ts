// Seasonal forecast for the /trends combo chart. The projection is derived from the REAL monthly
// actuals: each future month = the same calendar month one year earlier × a year-over-year growth
// factor, so the full seasonal shape (year-end peaks, summer dips) is carried forward rather than a
// flat line. The growth factor is the canonical /analytics estimate (estimateYoyGrowth: 3-year
// trailing median of complete-year ratios, clamped to [0.5, 2]) — nothing here is fabricated.
// Forecast points are always flagged `forecast: true` so the UI labels them „ПРОГНОЗА" and never
// renders them as actuals.

import type { TrendPoint } from '@sigma/api-contract';

import { estimateYoyGrowth, type GrowthFactors } from './analytics-stats';

export interface ForecastPoint {
  period: string; // 'YYYY-MM'
  valueEur: number;
  contracts: number;
  forecast: true;
}

// Project at most this many months forward (and never past the end of the year after the last actual).
const MAX_HORIZON = 18;

function addMonth(year: number, month: number): [number, number] {
  return month === 12 ? [year + 1, 1] : [year, month + 1];
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Project future months from the actual monthly series. The forecast starts the month after the last
 * COMPLETE month — a partial current month never seeds the projection — and runs to the end of the
 * year after the last actual (capped at MAX_HORIZON months). Each month is seeded from the same
 * calendar month one year earlier (actual, or an already-projected month) × the growth factor, so
 * seasonality dominates. A missing seasonal base yields 0 (honest: we never invent a level we have
 * no basis for).
 */
export function buildForecast(
  points: TrendPoint[],
  growth?: GrowthFactors,
  horizon = MAX_HORIZON,
): ForecastPoint[] {
  if (points.length === 0) return [];
  const g = growth ?? estimateYoyGrowth(points);

  const level = new Map<string, { value: number; count: number }>();
  for (const p of points) level.set(p.period, { value: p.valueEur, count: p.contracts });

  const lastComplete = [...points].reverse().find((p) => !p.partial) ?? points[points.length - 1]!;
  let [y, m] = lastComplete.period.split('-').map(Number) as [number, number];
  const endYear = Number(lastComplete.period.slice(0, 4)) + 1;

  const out: ForecastPoint[] = [];
  for (let i = 0; i < horizon; i += 1) {
    [y, m] = addMonth(y, m);
    if (y > endYear) break;
    const key = monthKey(y, m);
    const base = level.get(monthKey(y - 1, m)) ?? { value: 0, count: 0 };
    const value = base.value * g.value;
    const count = base.count * g.count;
    level.set(key, { value, count });
    out.push({ period: key, valueEur: value, contracts: count, forecast: true });
  }
  // No prior-year seasonal base for the first projected month (the actuals don't yet span a full year
  // before the forecast start) → the projection opens at 0, a „ПРОГНОЗА" wedge crashing to zero that
  // reads as a predicted collapse. Suppress the forecast entirely rather than render that false cliff.
  if (out.length === 0 || out[0]!.valueEur === 0) return [];
  return out;
}
