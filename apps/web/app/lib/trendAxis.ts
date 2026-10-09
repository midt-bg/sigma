// X-axis helpers shared by ComboTrendChart and TrendChart — the two SVG chart components that plot
// TrendPoint series over time. Kept in one place so their year-start/tick logic and period labels
// cannot drift between the two implementations (NO CODE DUPLICATION).

import type { TrendGranularity, TrendPoint } from '@sigma/api-contract';
import { monthYear } from '@sigma/shared';

/** 'YYYY-MM' → 'март 2024', 'YYYY-Qn' → 'Q1 2024', 'YYYY' → '2024'. */
export function periodLabel(period: string, granularity: TrendGranularity): string {
  if (granularity === 'year') return period;
  if (granularity === 'quarter') {
    const [y, q] = period.split('-Q');
    return `Q${q} ${y}`;
  }
  return monthYear(period);
}

export type AxisTick = { i: number; year: string };

/**
 * X-axis year labels at the first period of each year (or every point at year grain): month grain
 * ticks on '-01', quarter grain ticks on '-Q1', year grain ticks every point.
 */
export function yearAxisTicks(points: TrendPoint[], granularity: TrendGranularity): AxisTick[] {
  const yearStart = granularity === 'year' ? null : granularity === 'quarter' ? '-Q1' : '-01';
  return points
    .map((p, i) => ({ i, year: p.period.slice(0, 4) }))
    .filter(({ i }) => yearStart == null || points[i]!.period.endsWith(yearStart));
}
