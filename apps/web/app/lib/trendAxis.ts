import type { TrendGranularity, TrendPoint } from '@sigma/api-contract';

/**
 * x-axis year ticks: the first period of each year (month/quarter grain), or every point at year
 * grain. Shared by TrendChart and ComboTrendChart so the two SVGs agree on where year labels land.
 *
 * TODO(#170): PR #170 (договори overview) grows a third copy of this same logic — when it lands,
 * consolidate that copy onto this helper instead of leaving three independent implementations.
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
