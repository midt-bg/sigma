import type { TrendGranularity, TrendPoint } from '@sigma/api-contract';

/**
 * x-axis year ticks: the first period of each year (month/quarter grain), or every point at year
 * grain. Shared by TrendChart and ComboTrendChart so the two SVGs agree on where year labels land.
 */
export function yearAxisTicks(
  points: TrendPoint[],
  granularity: TrendGranularity,
): Array<{ i: number; year: string }> {
  const yearStart = granularity === 'year' ? null : granularity === 'quarter' ? '-Q1' : '-01';
  return points
    .map((p, i) => ({ i, year: p.period.slice(0, 4) }))
    .filter(({ i }) => yearStart == null || points[i]!.period.endsWith(yearStart));
}
