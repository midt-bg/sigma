import { describe, expect, it } from 'vitest';
import type { TrendGranularity, TrendPoint } from '@sigma/api-contract';
import { periodLabel, yearAxisTicks } from '../lib/trendAxis';

// Reference oracle: TrendChart's x-axis tick logic before it was extracted into
// lib/trendAxis.ts (the version this test file's namesake component used to inline).
function ticksBefore(points: TrendPoint[], granularity: TrendGranularity) {
  const yearStart = granularity === 'year' ? null : granularity === 'quarter' ? '-Q1' : '-01';
  return points
    .map((p, i) => ({ i, year: p.period.slice(0, 4) }))
    .filter((_t, idx) => yearStart == null || points[idx]!.period.endsWith(yearStart));
}

const monthPoints: TrendPoint[] = [
  { period: '2023-11', valueEur: 1, contracts: 1, partial: false },
  { period: '2023-12', valueEur: 1, contracts: 1, partial: false },
  { period: '2024-01', valueEur: 1, contracts: 1, partial: false },
  { period: '2024-02', valueEur: 1, contracts: 1, partial: false },
  { period: '2025-01', valueEur: 1, contracts: 1, partial: true },
];

const quarterPoints: TrendPoint[] = [
  { period: '2023-Q3', valueEur: 1, contracts: 1, partial: false },
  { period: '2023-Q4', valueEur: 1, contracts: 1, partial: false },
  { period: '2024-Q1', valueEur: 1, contracts: 1, partial: false },
  { period: '2024-Q2', valueEur: 1, contracts: 1, partial: true },
];

const yearPoints: TrendPoint[] = [
  { period: '2022', valueEur: 1, contracts: 1, partial: false },
  { period: '2023', valueEur: 1, contracts: 1, partial: false },
  { period: '2024', valueEur: 1, contracts: 1, partial: true },
];

describe('yearAxisTicks (shared helper used by TrendChart)', () => {
  it('matches TrendChart’s prior inline month-grain tick logic exactly', () => {
    expect(yearAxisTicks(monthPoints, 'month')).toEqual(ticksBefore(monthPoints, 'month'));
    expect(yearAxisTicks(monthPoints, 'month')).toEqual([
      { i: 2, year: '2024' },
      { i: 4, year: '2025' },
    ]);
  });

  it('matches TrendChart’s prior inline quarter-grain tick logic exactly', () => {
    expect(yearAxisTicks(quarterPoints, 'quarter')).toEqual(ticksBefore(quarterPoints, 'quarter'));
    expect(yearAxisTicks(quarterPoints, 'quarter')).toEqual([{ i: 2, year: '2024' }]);
  });

  it('matches TrendChart’s prior inline year-grain tick logic exactly (a tick per point)', () => {
    expect(yearAxisTicks(yearPoints, 'year')).toEqual(ticksBefore(yearPoints, 'year'));
    expect(yearAxisTicks(yearPoints, 'year')).toEqual([
      { i: 0, year: '2022' },
      { i: 1, year: '2023' },
      { i: 2, year: '2024' },
    ]);
  });
});

describe('periodLabel', () => {
  it('formats year/quarter/month periods as TrendChart’s tooltip and labels expect', () => {
    expect(periodLabel('2024', 'year')).toBe('2024');
    expect(periodLabel('2024-Q1', 'quarter')).toBe('Q1 2024');
  });
});
