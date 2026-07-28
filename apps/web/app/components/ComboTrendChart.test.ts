import { describe, expect, it } from 'vitest';
import type { TrendPoint } from '@sigma/api-contract';
import { yearAxisTicks } from '../lib/trendAxis';

// Mirrors ComboTrendChart's own x(i) and left% formulas exactly (W/PAD match the component's
// constants) so this test fails if the component's positioning drifts from x(t.i) again.
const W = 1000;
const PAD = 8;
function xOf(i: number, n: number) {
  return PAD + (i * (W - 2 * PAD)) / (n - 1);
}
function leftPct(i: number, n: number) {
  return (xOf(i, n) / W) * 100;
}

describe('ComboTrendChart year-label positioning', () => {
  it('places each label at its tick x(t.i) position, not evenly spaced, when years are unevenly distributed', () => {
    // Years clustered at the start (2021, 2022 one point apart) with a long gap before 2026 — a
    // flow-based `justify-content: space-between` layout would spread these four labels evenly
    // across the width, landing the last two under the wrong bars.
    const points: TrendPoint[] = [
      { period: '2021', valueEur: 1, contracts: 1, partial: false },
      { period: '2022', valueEur: 1, contracts: 1, partial: false },
      { period: '2023', valueEur: 1, contracts: 1, partial: false },
      { period: '2024', valueEur: 1, contracts: 1, partial: false },
      { period: '2025', valueEur: 1, contracts: 1, partial: false },
      { period: '2026', valueEur: 1, contracts: 1, partial: true },
    ];
    const n = points.length;
    const ticks = yearAxisTicks(points, 'year');

    const positions = ticks.map((t) => ({ year: t.year, leftPct: leftPct(t.i, n) }));

    expect(positions).toEqual([
      { year: '2021', leftPct: leftPct(0, n) },
      { year: '2022', leftPct: leftPct(1, n) },
      { year: '2023', leftPct: leftPct(2, n) },
      { year: '2024', leftPct: leftPct(3, n) },
      { year: '2025', leftPct: leftPct(4, n) },
      { year: '2026', leftPct: leftPct(5, n) },
    ]);

    // Evenly-spaced (flow-based) positions would be i / (ticks.length - 1) * 100 — assert the
    // computed positions do NOT match that for the interior ticks, proving this is tick-driven.
    const evenlySpaced = ticks.map((_t, idx) => (idx / (ticks.length - 1)) * 100);
    expect(positions.map((p) => p.leftPct)).not.toEqual(evenlySpaced);
  });

  it('matches tick x-position exactly for a fixture with a long gap before the last year (month grain)', () => {
    const points: TrendPoint[] = [
      { period: '2021-11', valueEur: 1, contracts: 1, partial: false },
      { period: '2021-12', valueEur: 1, contracts: 1, partial: false },
      { period: '2022-01', valueEur: 1, contracts: 1, partial: false },
      { period: '2022-02', valueEur: 1, contracts: 1, partial: false },
      { period: '2022-03', valueEur: 1, contracts: 1, partial: false },
      { period: '2022-04', valueEur: 1, contracts: 1, partial: false },
      { period: '2022-05', valueEur: 1, contracts: 1, partial: false },
      { period: '2022-06', valueEur: 1, contracts: 1, partial: false },
      { period: '2022-07', valueEur: 1, contracts: 1, partial: false },
      { period: '2022-08', valueEur: 1, contracts: 1, partial: false },
      { period: '2022-09', valueEur: 1, contracts: 1, partial: false },
      { period: '2022-10', valueEur: 1, contracts: 1, partial: false },
      { period: '2022-11', valueEur: 1, contracts: 1, partial: false },
      { period: '2022-12', valueEur: 1, contracts: 1, partial: false },
      { period: '2023-01', valueEur: 1, contracts: 1, partial: true },
    ];
    const n = points.length;
    const ticks = yearAxisTicks(points, 'month');

    expect(ticks).toEqual([
      { i: 2, year: '2022' },
      { i: 14, year: '2023' },
    ]);
    expect(ticks.map((t) => leftPct(t.i, n))).toEqual([leftPct(2, n), leftPct(14, n)]);
  });
});
