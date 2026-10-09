import { describe, expect, it } from 'vitest';
import type { TrendGranularity, TrendPoint } from '@sigma/api-contract';
import { monthYear } from '@sigma/shared';
import { periodLabel, yearAxisTicks } from '../lib/trendAxis';

// Reference oracle: ComboTrendChart's x-axis tick logic before it was extracted into
// lib/trendAxis.ts (byte-identical to TrendChart's prior inline copy — that duplication is what
// review thread ComboTrendChart.tsx:62 / TrendChart.tsx:36 flagged).
function ticksBefore(points: TrendPoint[], granularity: TrendGranularity) {
  const yearStart = granularity === 'year' ? null : granularity === 'quarter' ? '-Q1' : '-01';
  return points
    .map((p, i) => ({ i, year: p.period.slice(0, 4) }))
    .filter(({ i }) => yearStart == null || points[i]!.period.endsWith(yearStart));
}

// Reference oracle: ComboTrendChart's own periodLabel before the move to lib/trendAxis.ts.
function periodLabelBefore(period: string, granularity: TrendGranularity): string {
  if (granularity === 'year') return period;
  if (granularity === 'quarter') {
    const [y, q] = period.split('-Q');
    return `Q${q} ${y}`;
  }
  return monthYear(period);
}

const points: TrendPoint[] = [
  { period: '2023-11', valueEur: 10, contracts: 2, partial: false },
  { period: '2023-12', valueEur: 20, contracts: 3, partial: false },
  { period: '2024-01', valueEur: 30, contracts: 4, partial: false },
  { period: '2024-02', valueEur: 5, contracts: 1, partial: true },
];

describe('yearAxisTicks (shared helper used by ComboTrendChart)', () => {
  it('matches ComboTrendChart’s prior inline tick logic exactly across granularities', () => {
    for (const granularity of ['month', 'quarter', 'year'] as const) {
      expect(yearAxisTicks(points, granularity)).toEqual(ticksBefore(points, granularity));
    }
  });
});

describe('periodLabel (shared helper used by ComboTrendChart’s hover tooltip)', () => {
  it('matches ComboTrendChart’s prior inline periodLabel exactly for every granularity', () => {
    expect(periodLabel('2024-02', 'month')).toBe(periodLabelBefore('2024-02', 'month'));
    expect(periodLabel('2024-Q1', 'quarter')).toBe(periodLabelBefore('2024-Q1', 'quarter'));
    expect(periodLabel('2024', 'year')).toBe(periodLabelBefore('2024', 'year'));
  });
});
