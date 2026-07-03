import { describe, expect, it } from 'vitest';
import type { TrendPoint } from '@sigma/api-contract';
import { buildForecast } from './trends-forecast';

// buildForecast only — the growth estimate it defaults to (estimateYoyGrowth) is covered by
// analytics-stats.test.ts, its home.

// Build a full calendar year of monthly points with a flat per-month value/count.
function year(
  y: number,
  monthlyValue: number,
  monthlyCount: number,
  partial = false,
): TrendPoint[] {
  return Array.from({ length: 12 }, (_, i) => ({
    period: `${y}-${String(i + 1).padStart(2, '0')}`,
    valueEur: monthlyValue,
    contracts: monthlyCount,
    // mark the final month of the year partial when requested
    partial: partial && i === 11,
  }));
}

describe('buildForecast', () => {
  it('projects each month from the same month last year × growth, flagged forecast', () => {
    const points = [...year(2022, 100, 50), ...year(2023, 120, 55)];
    const fc = buildForecast(points, { value: 1.2, count: 1.1 });
    // last complete = 2023-12, so forecast runs 2024-01 .. 2024-12 (end of next year)
    expect(fc).toHaveLength(12);
    expect(fc[0]!.period).toBe('2024-01');
    expect(fc[0]!.forecast).toBe(true);
    expect(fc[0]!.valueEur).toBeCloseTo(120 * 1.2, 5); // 2023-01 × 1.2
    expect(fc[0]!.contracts).toBeCloseTo(55 * 1.1, 5);
    expect(fc.at(-1)!.period).toBe('2024-12');
  });

  it('starts the month after the last COMPLETE month when the tail is partial', () => {
    const points = [...year(2023, 100, 50), ...year(2024, 110, 52, true)];
    // 2024-12 is partial → last complete is 2024-11 → first forecast month is 2024-12
    const fc = buildForecast(points, { value: 1, count: 1 });
    expect(fc[0]!.period).toBe('2024-12');
    expect(fc.every((p) => p.forecast)).toBe(true);
  });

  it('returns nothing for an empty series', () => {
    expect(buildForecast([])).toEqual([]);
  });

  it('defaults the growth factor to the canonical actuals-based estimate', () => {
    const points = [...year(2021, 100, 50), ...year(2022, 120, 55), ...year(2023, 144, 60.5)];
    const fc = buildForecast(points); // estimateYoyGrowth → value ≈ 1.2
    expect(fc[0]!.valueEur).toBeCloseTo(144 * 1.2, 5);
  });

  it('suppresses the forecast when there is no prior-year seasonal base (no zero cliff)', () => {
    // Only a partial first half-year — there is no month one year earlier to seed any projection,
    // so every projected month would be 0. The forecast must be dropped, not rendered as a collapse.
    const points: TrendPoint[] = Array.from({ length: 6 }, (_, i) => ({
      period: `2024-${String(i + 1).padStart(2, '0')}`,
      valueEur: 100,
      contracts: 10,
      partial: false,
    }));
    expect(buildForecast(points, { value: 1, count: 1 })).toEqual([]);
  });
});
