import { describe, expect, it } from 'vitest';
import type { TrendPoint } from '@sigma/api-contract';
import {
  estimateYoyGrowth,
  formatPeakMonth,
  formatPpChange,
  formatYearlyGrowth,
  growthMultiple,
  opaqueHeadline,
  peakPoint,
  type OpaqueShareYear,
  type PeakablePoint,
} from './analytics-stats';
import { formatGrowthFactor } from './overruns-chart';

describe('growthMultiple', () => {
  it('turns a median overrun pct into 1 + pct as a ×-multiple', () => {
    expect(growthMultiple(2.1)).toBe('3,1× (+210%)');
    expect(growthMultiple(0.5)).toBe('1,5× (+50%)');
    // Delegates to formatGrowthFactor, which strips a trailing „,0" — so a whole multiple reads „1×".
    expect(growthMultiple(0)).toBe('1× (0%)');
  });
  it('matches /overruns formatGrowthFactor exactly (single source of truth)', () => {
    for (const pct of [2.1, 0.5, 0, 1, 3.04]) {
      expect(growthMultiple(pct)).toBe(formatGrowthFactor(pct));
    }
  });
  it('returns an em-dash for absent / non-finite input', () => {
    expect(growthMultiple(null)).toBe('—');
    expect(growthMultiple(undefined)).toBe('—');
    expect(growthMultiple(NaN)).toBe('—');
  });
});

describe('formatYearlyGrowth', () => {
  it('formats a ratio as a signed integer percent per year', () => {
    expect(formatYearlyGrowth(0.18)).toBe('+18%/год');
    expect(formatYearlyGrowth(-0.04)).toBe('−4%/год');
  });
  it('returns an em-dash for null', () => {
    expect(formatYearlyGrowth(null)).toBe('—');
  });
});

describe('peakPoint / formatPeakMonth', () => {
  const points: PeakablePoint[] = [
    { period: '2025-01', valueEur: 100 },
    { period: '2025-12', valueEur: 900 },
    { period: '2026-06', valueEur: 999, partial: true }, // partial — skipped
  ];
  it('finds the highest-value complete period', () => {
    expect(peakPoint(points)?.period).toBe('2025-12');
  });
  it('returns null for an empty / all-partial series', () => {
    expect(peakPoint([])).toBeNull();
    expect(peakPoint([{ period: '2026-06', valueEur: 5, partial: true }])).toBeNull();
  });
  it('abbreviates the month for the peak label', () => {
    expect(formatPeakMonth('2025-12')).toBe('дек 2025');
    expect(formatPeakMonth('2024-01')).toBe('яну 2024');
    expect(formatPeakMonth(null)).toBe('—');
  });
  it('passes an unparseable period through verbatim rather than inventing a month', () => {
    expect(formatPeakMonth('2025')).toBe('2025');
    expect(formatPeakMonth('2025-Q4')).toBe('2025-Q4');
    expect(formatPeakMonth('')).toBe('—');
  });
  it('falls back to the raw month number when it is outside 01–12', () => {
    expect(formatPeakMonth('2025-13')).toBe('13 2025');
  });
  it('keeps the first of two equal-valued periods as the peak', () => {
    const tie: PeakablePoint[] = [
      { period: '2025-03', valueEur: 500 },
      { period: '2025-04', valueEur: 500 },
    ];
    expect(peakPoint(tie)?.period).toBe('2025-03');
  });
});

describe('opaqueHeadline / formatPpChange', () => {
  const rows: OpaqueShareYear[] = [
    { year: '2020', valueEur: 1000, singleOfferValueEur: 200 }, // 20%
    { year: '2021', valueEur: 0, singleOfferValueEur: 0 }, // no value — dropped
    { year: '2025', valueEur: 1000, singleOfferValueEur: 350 }, // 35%
  ];
  it('reads first vs latest single-offer value share and the pp swing', () => {
    const h = opaqueHeadline(rows)!;
    expect(h.firstYear).toBe('2020');
    expect(h.latestYear).toBe('2025');
    expect(h.firstShare).toBeCloseTo(0.2);
    expect(h.latestShare).toBeCloseTo(0.35);
    expect(h.ppChange).toBeCloseTo(0.15);
  });
  it('returns null when no year has value', () => {
    expect(opaqueHeadline([{ year: '2020', valueEur: 0, singleOfferValueEur: 0 }])).toBeNull();
    expect(opaqueHeadline([])).toBeNull();
  });
  it('formats a percentage-point swing', () => {
    expect(formatPpChange(0.15)).toBe('+15 пр.п.');
    expect(formatPpChange(-0.03)).toBe('−3 пр.п.');
    expect(formatPpChange(0)).toBe('0 пр.п.');
    expect(formatPpChange(null)).toBe('—');
  });
});

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

describe('estimateYoyGrowth', () => {
  it('recovers the YoY growth factor from complete years', () => {
    const points = [...year(2021, 100, 50), ...year(2022, 120, 55), ...year(2023, 144, 60.5)];
    const g = estimateYoyGrowth(points);
    expect(g.value).toBeCloseTo(1.2, 5); // 100 → 120 → 144
    expect(g.count).toBeCloseTo(1.1, 5); // 50 → 55 → 60.5
  });

  it('flags fewer than two complete years as insufficient, and a real estimate as sufficient', () => {
    expect(estimateYoyGrowth(year(2022, 100, 50))).toMatchObject({ value: 1, insufficient: true });
    expect(estimateYoyGrowth([...year(2022, 100, 50), ...year(2023, 120, 50)]).insufficient).toBe(
      false,
    );
  });

  it('ignores the partial final year', () => {
    const points = [
      ...year(2021, 100, 50),
      ...year(2022, 120, 55),
      ...year(2023, 999, 999, true), // partial → excluded from the estimate
    ];
    const g = estimateYoyGrowth(points);
    expect(g.value).toBeCloseTo(1.2, 5);
  });

  it('returns a flat factor with fewer than two complete years', () => {
    expect(estimateYoyGrowth(year(2023, 100, 50, true))).toMatchObject({ value: 1, count: 1 });
  });

  it('never treats a ratio across a gap year as a one-year YoY factor', () => {
    // 2022 is missing entirely: [2021, 2023] are the only complete years. 100 → 144 spans TWO
    // years (~+20%/yr compounded) — reading it as a single-year +44% would overstate growth, so
    // the non-adjacent pair must produce no ratio at all → flat.
    const points = [...year(2021, 100, 50), ...year(2023, 144, 72)];
    expect(estimateYoyGrowth(points)).toMatchObject({ value: 1, count: 1 });
  });

  it('clamps an absurd ratio into the sane band', () => {
    const points = [...year(2021, 1, 1), ...year(2022, 1000, 1000)];
    const g = estimateYoyGrowth(points);
    expect(g.value).toBeLessThanOrEqual(2);
    expect(g.value).toBeGreaterThanOrEqual(0.5);
  });

  it('uses the median so an early corpus ramp-up year does not dominate the figure', () => {
    // 2020 is the artificially-low open-data ramp-up year: a one-off +260% spike, then a steady ~+15%.
    const points = [
      ...year(2020, 10, 5),
      ...year(2021, 36, 18), // +260% — the backfill artifact
      ...year(2022, 41, 20), // +14%
      ...year(2023, 47, 23), // +15%
      ...year(2024, 54, 26), // +15%
    ];
    const g = estimateYoyGrowth(points);
    // Endpoint CAGR / geometric mean would carry the spike forward at ~+52%/yr ((54/10)^(1/4)≈1.52).
    // GROWTH_TRAILING_YEARS = 3 keeps only the last three complete years (2022-2024), so the 2020→2021
    // spike is excluded by the sliding window itself, not by the median — the median of the resulting
    // two ratios (~+14%, ~+15%) lands on the genuine sustainable ~+15%.
    expect(g.value).toBeGreaterThan(1.1);
    expect(g.value).toBeLessThan(1.25);
  });

  it('reports a neutral count factor when no year has a positive count to divide by', () => {
    // Value grows +20%/yr but every month carries zero contracts → no valid count ratio exists.
    const points = [...year(2021, 100, 0), ...year(2022, 120, 0), ...year(2023, 144, 0)];
    const g = estimateYoyGrowth(points);
    expect(g.value).toBeCloseTo(1.2, 5);
    expect(g.count).toBe(1);
  });

  it('treats a collapse of the contract count to zero as noise (neutral 1), not as a −100% trend', () => {
    const points = [...year(2021, 100, 50), ...year(2022, 120, 0)];
    const g = estimateYoyGrowth(points);
    expect(g.value).toBeCloseTo(1.2, 5);
    expect(g.count).toBe(1);
  });

  it('does not stretch a two-year jump across a missing year into one YoY step', () => {
    // 2021 → 2023 with 2022 absent would read as a single +44% "year"; the pair is skipped instead.
    const g = estimateYoyGrowth([...year(2021, 100, 50), ...year(2023, 144, 72)]);
    expect(g).toMatchObject({ value: 1, count: 1 });
  });

  it('still uses the consecutive pair when a gap precedes it', () => {
    const g = estimateYoyGrowth([
      ...year(2020, 10, 5),
      ...year(2022, 100, 50),
      ...year(2023, 120, 55),
    ]);
    expect(g.value).toBeCloseTo(1.2, 5); // only 2022 → 2023 is a real one-year step
  });
});
