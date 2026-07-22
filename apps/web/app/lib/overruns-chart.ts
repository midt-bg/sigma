// Pure, SSR-safe geometry for the Overruns („Раздуване") dashboard. No DOM, no React — just maths,
// so it is unit-testable and the route stays a thin renderer. Two visual primitives:
//
//   1. overrunBarGeometry — the before→now stacked bar (ink = value at signing, accent = the overrun),
//      sized against a shared corpus scale so bars are comparable across rows.
//   2. scatterGeometry — the „Облак на раздуването" cloud: x = % growth on a log axis, y = € overrun
//      on a linear axis, bubble radius = annex count. Data-driven bounds (no hard-coded mock maxima),
//      with honest empty handling so a corpus with no overruns yields an empty (not NaN) chart.
//
// Both mirror the Claude-Design mock's proportions but read their extents from the real rows.

import { signedPct } from '@sigma/shared';

const round1 = (n: number): number => Math.round(n * 10) / 10;

export interface OverrunBarGeometry {
  /** Width of the ink (value-at-signing) segment, as a % of the bar's own length. */
  signPct: number;
  /** Width of the accent (overrun) segment, as a % of the bar's own length. */
  incPct: number;
  /** Length of the whole bar as a % of the shared corpus scale (0–100, clamped). */
  nowScalePct: number;
}

// One stacked bar. The two inner segments split the CURRENT value into „paid at signing" vs „ballooned
// after"; the whole bar's length is the current value against the corpus scale max (so the longest
// contract fills the track). Guards: a non-positive current collapses to an empty bar; signing is
// clamped into [0, current] so a stray over-large signing can never push incPct negative.
export function overrunBarGeometry(
  signingEur: number,
  currentEur: number,
  scaleMaxEur: number,
): OverrunBarGeometry {
  const current = Math.max(currentEur, 0);
  if (current <= 0) return { signPct: 0, incPct: 0, nowScalePct: 0 };
  const signing = Math.min(Math.max(signingEur, 0), current);
  const signShare = signing / current;
  const scale = scaleMaxEur > 0 ? Math.min(1, current / scaleMaxEur) : 0;
  const signPct = round1(signShare * 100);
  return { signPct, incPct: round1(100 - signPct), nowScalePct: round1(scale * 100) };
}

/**
 * Median-growth KPI: a pct ratio (0.5 = +50%) shown as a multiple of the signed value with the
 * percentage spelled out so „1,4×" cannot be misread as „40% of", e.g. „1,4× (+40%)".
 */
export function formatGrowthFactor(pctRatio: number): string {
  if (!Number.isFinite(pctRatio)) return '—';
  const factor = Math.max(0, 1 + pctRatio);
  const s = (Math.round(factor * 10) / 10).toFixed(1).replace(/\.0$/, '').replace('.', ',');
  return `${s}× (${signedPct(pctRatio)})`;
}

export interface ScatterDatum {
  /** Stable key (contract id) — echoed back so the renderer can wire selection/hover. */
  id: string;
  /** Growth ratio (0.5 = +50%); mapped onto the log x-axis as a percentage. */
  pct: number;
  /** Absolute overrun € — the linear y-axis. */
  deltaEur: number;
  /** Annex count — drives bubble radius. */
  annexCount: number;
  /** 1-based rank in the active ordering, used as the bubble label. */
  rank: number;
}

export interface ScatterPoint {
  id: string;
  rank: number;
  x: number;
  y: number;
  r: number;
  /** True for the heaviest overruns (top half by €) — the renderer paints these in the accent. */
  big: boolean;
}

export interface ScatterGridLine {
  y: number;
  /** € value this gridline marks (renderer formats it). */
  value: number;
}

export interface ScatterTick {
  x: number;
  /** Growth percentage (whole-number, e.g. 100 = +100%) this tick marks. */
  pctPercent: number;
}

export interface ScatterGeometry {
  width: number;
  height: number;
  /** Plot frame in viewBox units. */
  axis: { left: number; right: number; top: number; bottom: number };
  points: ScatterPoint[];
  grid: ScatterGridLine[];
  xticks: ScatterTick[];
}

export interface ScatterOptions {
  width?: number;
  height?: number;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  /** Floor for the log x-axis, in percent (avoids log(0) and keeps tiny growths on-scale). */
  minPctFloor?: number;
}

const DEFAULTS = {
  width: 380,
  height: 250,
  left: 40,
  right: 372,
  top: 16,
  bottom: 212,
  minPctFloor: 5,
};

// „Nice" round growth-% ticks spanning the data's log range. Picks from a fixed ladder so labels read
// as +10% / +100% / +1000% rather than arbitrary 10^x values.
const TICK_LADDER = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000];

function chooseXTicks(loPct: number, hiPct: number): number[] {
  const inRange = TICK_LADDER.filter((t) => t >= loPct && t <= hiPct);
  if (inRange.length >= 2) return inRange.slice(0, 5);
  // Degenerate/narrow range: bracket it with the nearest ladder stops so the axis still has marks.
  const below = [...TICK_LADDER].reverse().find((t) => t <= loPct) ?? TICK_LADDER[0]!;
  const above = TICK_LADDER.find((t) => t >= hiPct) ?? TICK_LADDER[TICK_LADDER.length - 1]!;
  return Array.from(new Set([below, above]));
}

// Build the cloud. Returns empty `points`/`grid`/`xticks` (but a valid frame) when there are no rows,
// so the SVG renders an honest empty plot rather than dividing by zero.
export function scatterGeometry(
  data: ScatterDatum[],
  options: ScatterOptions = {},
): ScatterGeometry {
  const o = { ...DEFAULTS, ...options };
  const axis = { left: o.left, right: o.right, top: o.top, bottom: o.bottom };
  const base: ScatterGeometry = {
    width: o.width,
    height: o.height,
    axis,
    points: [],
    grid: [],
    xticks: [],
  };
  if (data.length === 0) return base;

  const pctPercents = data.map((d) => Math.max(o.minPctFloor, d.pct * 100));
  const loPct = Math.min(...pctPercents);
  const hiPct = Math.max(...pctPercents);
  const logLo = Math.log10(loPct);
  const logHi = Math.log10(hiPct);
  const logSpan = logHi - logLo || 1; // identical pcts → flat range, avoid /0
  const xOf = (pctPercent: number): number => {
    const clamped = Math.max(loPct, Math.min(hiPct, pctPercent));
    return axis.left + ((Math.log10(clamped) - logLo) / logSpan) * (axis.right - axis.left);
  };

  const deltaMax = Math.max(...data.map((d) => d.deltaEur), 1);
  const yOf = (delta: number): number =>
    axis.bottom - (Math.max(0, delta) / deltaMax) * (axis.bottom - axis.top);

  const bigThreshold = deltaMax / 2;
  const points: ScatterPoint[] = data.map((d) => ({
    id: d.id,
    rank: d.rank,
    x: round1(xOf(Math.max(o.minPctFloor, d.pct * 100))),
    y: round1(yOf(d.deltaEur)),
    r: round1(4 + Math.min(Math.max(d.annexCount, 0), 12) * 1.25),
    big: d.deltaEur >= bigThreshold,
  }));

  const grid: ScatterGridLine[] = [0, 1 / 3, 2 / 3, 1].map((f) => {
    const value = deltaMax * f;
    return { y: round1(yOf(value)), value };
  });

  const xticks: ScatterTick[] = chooseXTicks(loPct, hiPct).map((pctPercent) => ({
    x: round1(xOf(pctPercent)),
    pctPercent,
  }));

  return { ...base, points, grid, xticks };
}
