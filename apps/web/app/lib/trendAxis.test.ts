import { describe, expect, it } from 'vitest';
import type { TrendPoint } from '@sigma/api-contract';
import { yearAxisTicks } from './trendAxis';

const pt = (period: string): TrendPoint => ({ period, valueEur: 1, contracts: 1, partial: false });

describe('yearAxisTicks', () => {
  it('ticks the first month of each year at month grain', () => {
    const points = ['2023-11', '2023-12', '2024-01', '2024-02'].map(pt);
    expect(yearAxisTicks(points, 'month')).toEqual([{ i: 2, year: '2024' }]);
  });

  it('ticks Q1 at quarter grain', () => {
    const points = ['2023-Q4', '2024-Q1', '2024-Q2'].map(pt);
    expect(yearAxisTicks(points, 'quarter')).toEqual([{ i: 1, year: '2024' }]);
  });

  it('ticks every point at year grain', () => {
    const points = ['2022', '2023'].map(pt);
    expect(yearAxisTicks(points, 'year')).toEqual([
      { i: 0, year: '2022' },
      { i: 1, year: '2023' },
    ]);
  });
});
