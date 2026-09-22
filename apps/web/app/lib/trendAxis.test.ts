import { describe, expect, it } from 'vitest';
import type { TrendPoint } from '@sigma/api-contract';
import { periodLabel, yearAxisTicks } from './trendAxis';

const pts = (...periods: string[]): TrendPoint[] =>
  periods.map((period) => ({ period, valueEur: 1, contracts: 1, partial: false }));

describe('periodLabel', () => {
  it('returns a year period untouched', () => {
    expect(periodLabel('2024', 'year')).toBe('2024');
  });

  it('writes a quarter as „Qn YYYY"', () => {
    expect(periodLabel('2024-Q3', 'quarter')).toBe('Q3 2024');
  });

  it('writes a month as a Bulgarian month name plus the year', () => {
    expect(periodLabel('2024-03', 'month')).toContain('2024');
    expect(periodLabel('2024-03', 'month')).not.toBe('2024-03');
  });
});

describe('yearAxisTicks', () => {
  it('labels every point at year grain', () => {
    expect(yearAxisTicks(pts('2022', '2023', '2024'), 'year')).toEqual([
      { i: 0, year: '2022' },
      { i: 1, year: '2023' },
      { i: 2, year: '2024' },
    ]);
  });

  it('labels only the first quarter of each year at quarter grain', () => {
    expect(yearAxisTicks(pts('2023-Q3', '2023-Q4', '2024-Q1', '2024-Q2'), 'quarter')).toEqual([
      { i: 2, year: '2024' },
    ]);
  });

  it('labels only January of each year at month grain, keeping the point index', () => {
    expect(yearAxisTicks(pts('2023-11', '2023-12', '2024-01', '2024-02'), 'month')).toEqual([
      { i: 2, year: '2024' },
    ]);
  });

  it('returns no ticks for an empty series', () => {
    expect(yearAxisTicks([], 'month')).toEqual([]);
  });
});
