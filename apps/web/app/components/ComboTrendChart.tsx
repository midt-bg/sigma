import { useState } from 'react';
import type { TrendGranularity, TrendPoint } from '@sigma/api-contract';
import { count, money, monthYear } from '@sigma/shared';

// Bar + line combo for the contracts overview (/trends): bars carry the contract count, the ink line
// the € volume. Server-rendered SVG like TrendChart; the only client behavior is the hover tooltip
// (React state after hydration — SSR renders the chart without it, so no-JS still gets the picture).
// The accessible data lives in the year cards next to the chart, matching the TrendChart pattern.

const W = 1000;
const H = 300;
const TOP = 10;
const BOT = 272;
const PAD = 8;

/** 'YYYY-MM' → 'март 2024', 'YYYY-Qn' → 'Q1 2024', 'YYYY' → '2024'. */
export function periodLabel(period: string, granularity: TrendGranularity): string {
  if (granularity === 'year') return period;
  if (granularity === 'quarter') {
    const [y, q] = period.split('-Q');
    return `Q${q} ${y}`;
  }
  return monthYear(period);
}

export function ComboTrendChart({
  points,
  granularity,
  cssHeight = 240,
  interactive = true,
  ariaLabel = 'Брой договори и € обем във времето',
}: {
  points: TrendPoint[];
  granularity: TrendGranularity;
  cssHeight?: number;
  interactive?: boolean;
  ariaLabel?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return null;

  const n = points.length;
  const vMax = Math.max(1, ...points.map((p) => p.valueEur)) * 1.12;
  const cMax = Math.max(1, ...points.map((p) => p.contracts));
  const x = (i: number) => (n > 1 ? PAD + (i * (W - 2 * PAD)) / (n - 1) : W / 2);
  const yV = (v: number) => BOT - (v / vMax) * (BOT - TOP);
  const yC = (c: number) => BOT - (c / cMax) * (BOT - TOP) * 0.62;
  const bw = Math.max(2, ((W - 2 * PAD) / n) * 0.66);

  // Final period is partial (still filling): dashed line tail + faded bar, like TrendChart.
  // `partialIdx > 0` assumes at least 2 solid points precede it — a partial at index 0 renders as
  // solid instead (mirrors the same assumption in TrendChart).
  const partialIdx = points.findIndex((p) => p.partial);
  const hasPartial = partialIdx > 0;
  const solidEnd = hasPartial ? partialIdx - 1 : n - 1;
  const xy = (i: number) => `${x(i).toFixed(1)} ${yV(points[i]!.valueEur).toFixed(1)}`;
  const line = points
    .slice(0, solidEnd + 1)
    .map((_p, i) => `${i ? 'L' : 'M'}${xy(i)}`)
    .join(' ');
  const dashed = hasPartial ? `M${xy(solidEnd)} L${xy(partialIdx)}` : '';

  // x-axis year labels at the first period of each year (or every point at year grain).
  const yearStart = granularity === 'year' ? null : granularity === 'quarter' ? '-Q1' : '-01';
  const ticks = points
    .map((p, i) => ({ i, year: p.period.slice(0, 4) }))
    .filter(({ i }) => yearStart == null || points[i]!.period.endsWith(yearStart));

  const hp = hover != null ? points[hover] : null;

  return (
    <div className="combo-chart" onMouseLeave={() => interactive && setHover(null)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ display: 'block', width: '100%', height: cssHeight }}
        role="img"
        aria-label={ariaLabel}
      >
        {[0, 1 / 3, 2 / 3, 1].map((f) => (
          <line
            key={f}
            className="combo-grid"
            x1={0}
            y1={yV(vMax * f).toFixed(1)}
            x2={W}
            y2={yV(vMax * f).toFixed(1)}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {points.map((p, i) => (
          <rect
            key={p.period}
            className={`combo-bar${hover === i ? ' is-hover' : ''}${p.partial ? ' is-partial' : ''}`}
            x={(x(i) - bw / 2).toFixed(1)}
            y={yC(p.contracts).toFixed(1)}
            width={bw.toFixed(1)}
            height={(BOT - yC(p.contracts)).toFixed(1)}
            onMouseEnter={interactive ? () => setHover(i) : undefined}
            onFocus={interactive ? () => setHover(i) : undefined}
          />
        ))}
        <path className="combo-line" d={line} vectorEffect="non-scaling-stroke" />
        {hasPartial && (
          <path className="combo-line-partial" d={dashed} vectorEffect="non-scaling-stroke" />
        )}
        {hp && hover != null && (
          <>
            <line
              className="combo-cursor"
              x1={x(hover).toFixed(1)}
              y1={6}
              x2={x(hover).toFixed(1)}
              y2={BOT}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              className="combo-dot"
              cx={x(hover).toFixed(1)}
              cy={yV(hp.valueEur).toFixed(1)}
              r={4}
              vectorEffect="non-scaling-stroke"
            />
          </>
        )}
      </svg>
      <div className="combo-xlab" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t.i}>{t.year}</span>
        ))}
      </div>
      {hp && hover != null && (
        <div
          className="combo-tip"
          role="status"
          style={{
            left: `${((x(hover) / W) * 100).toFixed(1)}%`,
            top: (yV(hp.valueEur) / H) * cssHeight - 4,
          }}
        >
          <div className="combo-tip-label">
            {periodLabel(hp.period, granularity)}
            {hp.partial ? ' · частично' : ''}
          </div>
          <div className="combo-tip-row">
            <span>€ обем</span>
            <strong>{money(hp.valueEur)}</strong>
          </div>
          <div className="combo-tip-row">
            <span>договори</span>
            <strong>{count(hp.contracts)}</strong>
          </div>
        </div>
      )}
    </div>
  );
}
