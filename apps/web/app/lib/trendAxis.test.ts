import { describe, expect, it } from 'vitest';
import type { TrendPoint } from '@sigma/api-contract';
import { yearAxisTicks } from './trendAxis';

function point(period: string): TrendPoint {
  return { period, valueEur: 0, contracts: 0, partial: false };
}

describe('yearAxisTicks', () => {
  it('returns every point at year granularity', () => {
    const points = [point('2023'), point('2024'), point('2025')];
    expect(yearAxisTicks(points, 'year')).toEqual([
      { i: 0, year: '2023' },
      { i: 1, year: '2024' },
      { i: 2, year: '2025' },
    ]);
  });

  it('returns only the Q1 point per year at quarter granularity', () => {
    const points = [point('2023-Q3'), point('2024-Q1'), point('2024-Q2'), point('2025-Q1')];
    expect(yearAxisTicks(points, 'quarter')).toEqual([
      { i: 1, year: '2024' },
      { i: 3, year: '2025' },
    ]);
  });

  it('returns only the January point per year at month granularity', () => {
    const points = [point('2023-06'), point('2024-01'), point('2024-02')];
    expect(yearAxisTicks(points, 'month')).toEqual([{ i: 1, year: '2024' }]);
  });
});
