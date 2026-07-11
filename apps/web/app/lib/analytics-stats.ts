// Pure, unit-tested formatters + derivations for the /analytics landing cards. Each card shows two
// real KPI figures sourced from the loader's rollup queries; these helpers turn the raw numbers the
// DB returns into the exact card strings (a growth multiple, a yearly-growth tag, an abbreviated peak
// month, a percentage-point swing). No DB, no rendering — just arithmetic + formatting, so they can
// be tested in isolation (repo convention: no render tests). Every helper is honest about thin data:
// a missing / non-finite input returns the em-dash, never a fabricated figure.

import type { TrendPoint } from '@sigma/api-contract';
import { signedPct } from '@sigma/shared';

import { formatGrowthFactor } from './overruns-chart';

const EM_DASH = '—';

// Abbreviated Bulgarian month names for the trend „ПИК" stat (e.g. '2025-12' → „дек 2025").
const MONTHS_SHORT_BG = [
  'яну',
  'фев',
  'мар',
  'апр',
  'май',
  'юни',
  'юли',
  'авг',
  'сеп',
  'окт',
  'ное',
  'дек',
];

// Median post-annex growth as a multiple of the signing value: a median overrun of +210% (pct 2.1)
// reads „3,1×". Delegates to /overruns' formatGrowthFactor so /analytics and /overruns render the
// identical string (single source of truth for the „×" formatting); null/non-finite → em-dash.
export function growthMultiple(medianPct: number | null | undefined): string {
  if (medianPct == null || !Number.isFinite(medianPct)) return EM_DASH;
  return formatGrowthFactor(medianPct);
}

// „+18%/год" — yearly growth as a signed integer percentage with the per-year suffix. The input ratio
// is the canonical /trends growth estimate (3-year trailing median, clamped) so the landing card and
// the /trends header always read the same figure.
export function formatYearlyGrowth(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return EM_DASH;
  return `${signedPct(ratio, 0)}/год`;
}

export interface PeakablePoint {
  period: string; // 'YYYY-MM'
  valueEur: number;
  partial?: boolean;
}

// The highest-value complete period in the series (the partial final period is skipped so a half-month
// dip never reads as the peak). Returns null for an empty / all-partial series.
export function peakPoint<T extends PeakablePoint>(points: T[]): T | null {
  let best: T | null = null;
  for (const p of points) {
    if (p.partial) continue;
    if (best == null || p.valueEur > best.valueEur) best = p;
  }
  return best;
}

// 'YYYY-MM' → „дек 2025" (abbreviated month + year).
export function formatPeakMonth(period: string | null | undefined): string {
  if (!period) return EM_DASH;
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return period;
  const month = MONTHS_SHORT_BG[Number(m[2]) - 1] ?? m[2];
  return `${month} ${m[1]}`;
}

export interface OpaqueShareYear {
  year: string;
  valueEur: number;
  singleOfferValueEur: number;
}

export interface OpaqueHeadline {
  latestYear: string;
  latestShare: number; // ratio
  firstYear: string;
  firstShare: number; // ratio
  ppChange: number; // latestShare − firstShare, in ratio units (multiply by 100 for пр.п.)
}

// Single-offer value share for the latest and first years on record, plus the percentage-point swing
// between them. Years with no value are dropped (their share is undefined); null when nothing remains.
export function opaqueHeadline(rows: OpaqueShareYear[]): OpaqueHeadline | null {
  const usable = rows.filter((r) => r.valueEur > 0).sort((a, b) => a.year.localeCompare(b.year));
  if (usable.length === 0) return null;
  const first = usable[0]!;
  const last = usable[usable.length - 1]!;
  // singleOfferValueEur can exceed valueEur (or dip below 0) on dirty source rows — clamp so the
  // share stays a valid ratio.
  const clampRatio = (v: number) => Math.min(1, Math.max(0, v));
  const firstShare = clampRatio(first.singleOfferValueEur / first.valueEur);
  const latestShare = clampRatio(last.singleOfferValueEur / last.valueEur);
  return {
    latestYear: last.year,
    latestShare,
    firstYear: first.year,
    firstShare,
    ppChange: latestShare - firstShare,
  };
}

// A percentage-point swing as „+7 пр.п." / „−3 пр.п." (rounded to a whole point). Input is a ratio
// difference (0.07 → „+7 пр.п."); a flat or non-finite delta drops the sign.
export function formatPpChange(deltaRatio: number | null | undefined): string {
  if (deltaRatio == null || !Number.isFinite(deltaRatio)) return EM_DASH;
  const points = Math.round(deltaRatio * 100);
  const sign = points > 0 ? '+' : points < 0 ? '−' : '';
  return `${sign}${Math.abs(points)} пр.п.`;
}

// ===== YoY growth estimate for the „Тренд" card =====
// Ported from the retired /trends seasonal forecast so /analytics owns the derivation it renders.

export interface GrowthFactors {
  value: number; // YoY multiplier for spend (1.0 = flat)
  count: number; // YoY multiplier for contract count
}

// Guard against a single freak year producing an absurd growth figure. A real YoY ratio for national
// procurement sits well inside this band; anything outside is treated as data noise and clamped.
const MIN_GROWTH = 0.5;
const MAX_GROWTH = 2;

function clampGrowth(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.min(MAX_GROWTH, Math.max(MIN_GROWTH, ratio));
}

function median(xs: number[]): number {
  if (xs.length === 0) return 1;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// The growth rate is estimated from a TRAILING window of the most recent complete years, not the
// whole history. The early years of this corpus are the open-data feed's ramp-up (2020 → 2021 was
// +258% as the backfill filled in) — carrying that one-off spike forward gives an absurdly aggressive
// figure (~+57%/yr). A 3-year trailing window captures the genuine, sustainable recent rate.
const GROWTH_TRAILING_YEARS = 3;

/**
 * Estimate the YoY growth multiplier (spend + contract count) from the actual monthly series.
 * Only complete years (12 non-partial months with a positive total) feed the estimate; the partial
 * final year and a partial first year are ignored so a half-year never skews the ratio. Of those,
 * only the last {@link GROWTH_TRAILING_YEARS} are used (the trailing window above) — and this
 * trailing window is what protects the figure from the early ramp-up years, not the median per se.
 * The factor is the median of the consecutive year ratios within the window; at the default 3-year
 * window there are only two ratios, so the median coincides with their mean. Fewer than two complete
 * years → flat.
 */
export function estimateYoyGrowth(points: TrendPoint[]): GrowthFactors {
  const byYear = new Map<
    number,
    { value: number; count: number; months: number; partial: boolean }
  >();
  for (const p of points) {
    const y = Number(p.period.slice(0, 4));
    const acc = byYear.get(y) ?? { value: 0, count: 0, months: 0, partial: false };
    acc.value += p.valueEur;
    acc.count += p.contracts;
    acc.months += 1;
    if (p.partial) acc.partial = true;
    byYear.set(y, acc);
  }
  const complete = [...byYear.entries()]
    .filter(([, v]) => v.months === 12 && !v.partial && v.value > 0)
    .sort((a, b) => a[0] - b[0]);
  if (complete.length < 2) return { value: 1, count: 1 };
  // Only the last N complete years (the trailing window) drive the rate.
  const recent = complete.slice(-GROWTH_TRAILING_YEARS);

  const valueRatios: number[] = [];
  const countRatios: number[] = [];
  for (let i = 1; i < recent.length; i += 1) {
    const prev = recent[i - 1]![1];
    const cur = recent[i]![1];
    if (prev.value > 0) valueRatios.push(cur.value / prev.value);
    if (prev.count > 0) countRatios.push(cur.count / prev.count);
  }
  return {
    value: clampGrowth(valueRatios.length ? median(valueRatios) : 1),
    count: clampGrowth(countRatios.length ? median(countRatios) : 1),
  };
}
