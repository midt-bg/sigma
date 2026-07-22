import { describe, expect, it } from 'vitest';
import {
  formatGrowthFactor,
  overrunBarGeometry,
  scatterGeometry,
  type ScatterDatum,
} from './overruns-chart';

describe('overrunBarGeometry', () => {
  it('splits the current value into signing + overrun shares that sum to 100', () => {
    const g = overrunBarGeometry(1_000_000, 1_500_000, 3_000_000);
    expect(g.signPct).toBeCloseTo(66.7, 1);
    expect(g.incPct).toBeCloseTo(33.3, 1);
    expect(g.signPct + g.incPct).toBeCloseTo(100, 1);
  });

  it('scales the bar length against the corpus max (longest contract fills the track)', () => {
    expect(overrunBarGeometry(1, 3_000_000, 3_000_000).nowScalePct).toBe(100);
    expect(overrunBarGeometry(1, 1_500_000, 3_000_000).nowScalePct).toBe(50);
  });

  it('clamps an over-large signing so the overrun share can never go negative', () => {
    const g = overrunBarGeometry(5_000_000, 1_000_000, 1_000_000);
    expect(g.signPct).toBe(100);
    expect(g.incPct).toBe(0);
  });

  it('collapses to an empty bar for a non-positive current value (honest, no NaN)', () => {
    const g = overrunBarGeometry(0, 0, 1_000_000);
    expect(g).toEqual({ signPct: 0, incPct: 0, nowScalePct: 0 });
  });
});

describe('formatGrowthFactor', () => {
  it('renders a pct ratio as a Bulgarian-formatted multiple of the signed value', () => {
    expect(formatGrowthFactor(2.1)).toBe('3,1× (+210%)');
    expect(formatGrowthFactor(1)).toBe('2× (+100%)');
    expect(formatGrowthFactor(0)).toBe('1× (0%)');
  });

  it('returns an em-dash for a non-finite input', () => {
    expect(formatGrowthFactor(Number.NaN)).toBe('—');
  });
});

describe('scatterGeometry', () => {
  const rows: ScatterDatum[] = [
    { id: 'a', pct: 0.25, deltaEur: 65_000_000, annexCount: 1, rank: 1 },
    { id: 'b', pct: 0.5, deltaEur: 56_000_000, annexCount: 9, rank: 2 },
    { id: 'c', pct: 48.18, deltaEur: 52_000_000, annexCount: 3, rank: 3 },
    { id: 'd', pct: 36.19, deltaEur: 24_000_000, annexCount: 2, rank: 4 },
  ];

  it('returns an honest empty plot (valid frame, no points) for no rows', () => {
    const g = scatterGeometry([]);
    expect(g.points).toHaveLength(0);
    expect(g.grid).toHaveLength(0);
    expect(g.xticks).toHaveLength(0);
    expect(g.axis.right).toBeGreaterThan(g.axis.left);
  });

  it('maps higher growth % further right on the log x-axis', () => {
    const g = scatterGeometry(rows);
    const byId = Object.fromEntries(g.points.map((p) => [p.id, p]));
    expect(byId.c!.x).toBeGreaterThan(byId.b!.x);
    expect(byId.b!.x).toBeGreaterThan(byId.a!.x);
  });

  it('maps larger overrun € higher (smaller y) on the linear y-axis', () => {
    const g = scatterGeometry(rows);
    const byId = Object.fromEntries(g.points.map((p) => [p.id, p]));
    expect(byId.a!.y).toBeLessThan(byId.d!.y); // 65M sits above 24M
  });

  it('grows the bubble radius with the annex count', () => {
    const g = scatterGeometry(rows);
    const byId = Object.fromEntries(g.points.map((p) => [p.id, p]));
    expect(byId.b!.r).toBeGreaterThan(byId.a!.r); // 9 annexes vs 1
  });

  it('flags overruns at least half the corpus max € overrun as big', () => {
    const g = scatterGeometry(rows);
    const byId = Object.fromEntries(g.points.map((p) => [p.id, p]));
    expect(byId.a!.big).toBe(true);
    expect(byId.d!.big).toBe(false);
  });

  it('keeps every point inside the plot frame', () => {
    const g = scatterGeometry(rows);
    for (const p of g.points) {
      expect(p.x).toBeGreaterThanOrEqual(g.axis.left);
      expect(p.x).toBeLessThanOrEqual(g.axis.right);
      expect(p.y).toBeGreaterThanOrEqual(g.axis.top);
      expect(p.y).toBeLessThanOrEqual(g.axis.bottom);
    }
  });

  it('emits nice round growth-% ticks within the data range', () => {
    const g = scatterGeometry(rows);
    expect(g.xticks.length).toBeGreaterThanOrEqual(2);
    for (const t of g.xticks) {
      expect(t.x).toBeGreaterThanOrEqual(g.axis.left - 0.1);
      expect(t.x).toBeLessThanOrEqual(g.axis.right + 0.1);
    }
  });

  it('samples ticks evenly across a wide range so the upper end is labeled too', () => {
    // pct range here spans 25%..4818% — 7 ladder stops fall in range, more than the 5-tick cap, so a
    // naive "take the lowest 5" would leave the top ~40% of the axis without a label.
    const g = scatterGeometry(rows);
    const percents = g.xticks.map((t) => t.pctPercent);
    expect(Math.max(...percents)).toBeGreaterThanOrEqual(1000);
    // The highest tick should land near the right edge of the plot, not stop partway across.
    const rightmost = g.xticks.reduce((a, b) => (b.x > a.x ? b : a));
    expect(rightmost.x).toBeGreaterThan(g.axis.left + 0.7 * (g.axis.right - g.axis.left));
  });
});
