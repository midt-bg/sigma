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

describe('overrunBarGeometry — degenerate scale', () => {
  it('draws a zero-length bar when the corpus scale max is not positive, keeping the split honest', () => {
    expect(overrunBarGeometry(1_000, 4_000, 0)).toEqual({
      signPct: 25,
      incPct: 75,
      nowScalePct: 0,
    });
    expect(overrunBarGeometry(1_000, 4_000, -5).nowScalePct).toBe(0);
  });

  it('caps the bar at the full track when current exceeds the scale max', () => {
    expect(overrunBarGeometry(1_000, 4_000, 2_000).nowScalePct).toBe(100);
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

  it('flags the heaviest overruns (top half by €) as big', () => {
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

  it('clamps tick LABELS to the real data range on a degenerate/narrow range (no ladder stop falls in range)', () => {
    // All rows sit at pct=0.3 (30%), a value with no exact TICK_LADDER stop — chooseXTicks brackets
    // it with the nearest stops (25 and 50), both outside [30, 30]; the label must not claim +25%/+50%
    // exist in the data when only +30% does.
    const degenerate: ScatterDatum[] = [
      { id: 'x', pct: 0.3, deltaEur: 1_000_000, annexCount: 1, rank: 1 },
      { id: 'y', pct: 0.3, deltaEur: 2_000_000, annexCount: 2, rank: 2 },
    ];
    const g = scatterGeometry(degenerate);
    for (const t of g.xticks) {
      expect(t.pctPercent).toBeGreaterThanOrEqual(30);
      expect(t.pctPercent).toBeLessThanOrEqual(30);
    }
  });
});

describe('scatterGeometry — x-axis tick selection', () => {
  const at = (pct: number): ScatterDatum => ({
    id: `p${pct}`,
    pct,
    deltaEur: 1_000,
    annexCount: 1,
    rank: 1,
  });
  const ticksFor = (...pcts: number[]) =>
    scatterGeometry(pcts.map(at)).xticks.map((t) => t.pctPercent);

  it('keeps every ladder stop when at most five fall inside the data range', () => {
    // 20%..600% spans the 25/50/100/250/500 stops — exactly the cap, so none are dropped.
    expect(ticksFor(0.2, 6)).toEqual([25, 50, 100, 250, 500]);
  });

  it('never labels a tick outside the range the data actually spans', () => {
    // A lone point has no two ladder stops in range; the bracketing stops (100 / 250) are clamped
    // back onto the value so the axis cannot show a growth figure absent from the data.
    expect(ticksFor(1.2).every((t) => t === 120)).toBe(true);
  });

  it('collapses to one tick when the value sits exactly on a ladder stop, without dividing by zero', () => {
    const g = scatterGeometry([at(1)]); // +100% exactly
    expect(g.xticks.map((t) => t.pctPercent)).toEqual([100]);
    expect(Number.isFinite(g.points[0]!.x)).toBe(true);
    expect(Number.isFinite(g.xticks[0]!.x)).toBe(true);
  });

  it('labels growth below the plotted floor at the floor, not at the first ladder stop', () => {
    // The x-axis floor is 5%, under the first ladder stop (10%) → the lower bracket falls back to 10
    // and is then clamped to the data range.
    expect(ticksFor(0.01)).toEqual([5]);
  });

  it('labels growth beyond the ladder at the data value, not at the last ladder stop', () => {
    expect(ticksFor(1_000)).toEqual([100_000]);
  });
});
