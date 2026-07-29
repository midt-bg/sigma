// Timeseries line chart — hand-built CSS/SVG, no chart library (spec §D1).
//
// Renders the `timeseries` report block. Supports both the single-series variant
// (`points: [{period, value}]`) and the multi-series variant (`series: [{label, points}]`).
// The SVG scales responsively via a fixed viewBox and CSS `width: 100%`.

import type { CellFormat } from '~/lib/assistant-contract/report';
import { formatCell } from '~/lib/assistant/render-format';

// Chart geometry in SVG user-space.
const W = 540;
const H = 200;
const PAD = { top: 16, right: 24, bottom: 38, left: 64 } as const;
const CHART_W = W - PAD.left - PAD.right; // 452
const CHART_H = H - PAD.top - PAD.bottom; // 146

// Number of Y-axis gridlines (excluding the baseline).
const Y_TICK_COUNT = 4;
// Maximum X-axis period labels before thinning to avoid overlap.
const MAX_X_LABELS = 8;

// CSS class cycle for multi-series stroke colours (defined in app.css under .ts-s0–.ts-s3).
// Capped at 4 entries; series beyond the 4th are dropped by `.slice(0, MAX_SERIES)` below (only
// single-series is emitted today). If multi-series past 4 ever ships, surface a truncation note.
// Multi-series is a future extension; the public block contract only emits single-series today.
const SERIES_CLASSES = ['ts-s0', 'ts-s1', 'ts-s2', 'ts-s3'] as const;
const MAX_SERIES = SERIES_CLASSES.length;

type TimeseriesPoint = { period: string | number | null; value: number };

export interface TimeseriesBlockProps {
  /** Single-series points (the flat variant emitted by bindReport). */
  points?: TimeseriesPoint[];
  /** Multi-series variant (the dock contract's extended form). */
  series?: { label: string; points: TimeseriesPoint[] }[];
  truncated?: boolean;
  /** Value display format — applied to the data table and exports (mirrors bar's format prop). */
  format?: CellFormat;
}

/** Compact number formatter for Y-axis tick labels (avoids importing @sigma/shared for pure UI). */
function fmtTick(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs < 10_000_000 ? 1 : 0)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs < 10_000 ? 1 : 0)}k`;
  return n.toFixed(abs > 0 && abs < 1 ? 2 : 0);
}

/** Normalise both variants to a uniform `[{label, pts}]` list. */
function toSeries(props: TimeseriesBlockProps): { label: string; pts: TimeseriesPoint[] }[] {
  if (props.series && props.series.length > 0) {
    return props.series.map((s) => ({ label: s.label, pts: s.points }));
  }
  if (props.points && props.points.length > 0) {
    return [{ label: '', pts: props.points }];
  }
  return [];
}

/**
 * SVG timeseries line chart for report blocks (spec §D1).
 * No chart library — pure SVG path + circle elements, CSS-styled.
 */
export function TimeseriesBlock({ points, series, truncated, format }: TimeseriesBlockProps) {
  const allSeries = toSeries({ points, series }).slice(0, MAX_SERIES);

  if (allSeries.length === 0 || allSeries.every((s) => s.pts.length === 0)) {
    return <p className="chart-empty">Няма данни</p>;
  }

  // Y domain across all series.
  const allValues = allSeries.flatMap((s) => s.pts.map((p) => p.value));
  let minVal = Infinity,
    maxVal = -Infinity;
  for (const v of allValues) {
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }
  const valueSpan = maxVal - minVal || 1;

  // X axis is driven by the longest series (all series share the same period index).
  const longestSeries = allSeries.reduce((a, b) => (a.pts.length >= b.pts.length ? a : b));
  const ptCount = longestSeries.pts.length;

  const xOf = (i: number): number =>
    PAD.left + (ptCount > 1 ? (i / (ptCount - 1)) * CHART_W : CHART_W / 2);
  // Y increases downward in SVG; higher values map to smaller y.
  const yOf = (v: number): number => PAD.top + CHART_H - ((v - minVal) / valueSpan) * CHART_H;

  // Y-axis: evenly spaced ticks from minVal to maxVal.
  const yTicks = Array.from({ length: Y_TICK_COUNT + 1 }, (_, i) => {
    const fraction = i / Y_TICK_COUNT;
    return { y: PAD.top + CHART_H - fraction * CHART_H, value: minVal + fraction * valueSpan };
  });

  // X-axis labels: show every nth point to avoid overlap.
  const xStep = Math.ceil(ptCount / MAX_X_LABELS);
  const xLabelIndices = longestSeries.pts
    .map((_, i) => i)
    .filter((i) => i % xStep === 0 || i === ptCount - 1);

  return (
    <figure className="timeseries-block">
      {/* Visually-hidden data table — the AT-accessible source (WCAG 1.1.1).
          The SVG is aria-hidden; screen readers and text-only mode use this table instead.
          AccessibilityWidget's SURVIVAL_CSS reveals .ts-data-table when text-only is active. */}
      <table className="ts-data-table" aria-label="Данни от времевата редица">
        <thead>
          <tr>
            <th scope="col">Период</th>
            {allSeries.length > 1 ? (
              allSeries.map((s, si) => (
                <th key={si} scope="col">
                  {s.label || `Серия ${si + 1}`}
                </th>
              ))
            ) : (
              <th scope="col">Стойност</th>
            )}
          </tr>
        </thead>
        <tbody>
          {longestSeries.pts.map((pt, i) => (
            <tr key={i}>
              <td>{String(pt.period ?? '')}</td>
              {allSeries.map((s, si) => (
                <td key={si}>
                  {s.pts[i] != null ? formatCell(s.pts[i].value, format ?? 'money') : '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true" className="timeseries-block__svg">
        {/* Gridlines + Y-axis labels */}
        {yTicks.map((tick, ti) => (
          <g key={ti}>
            <line
              x1={PAD.left}
              y1={tick.y.toFixed(1)}
              x2={PAD.left + CHART_W}
              y2={tick.y.toFixed(1)}
              className="ts-gridline"
            />
            <text
              x={PAD.left - 6}
              y={tick.y.toFixed(1)}
              textAnchor="end"
              dominantBaseline="middle"
              className="ts-label"
            >
              {fmtTick(tick.value)}
            </text>
          </g>
        ))}

        {/* X-axis period labels */}
        {xLabelIndices.map((i) => {
          const pt = longestSeries.pts[i];
          return (
            <text
              key={i}
              x={xOf(i).toFixed(1)}
              y={PAD.top + CHART_H + 16}
              textAnchor="middle"
              className="ts-label"
            >
              {pt ? String(pt.period ?? '') : ''}
            </text>
          );
        })}

        {/* One <g> per series: path + dot overlay */}
        {allSeries.map((s, si) => {
          const svgPts = s.pts.map((p, i) => ({
            x: xOf(i),
            y: yOf(p.value),
            period: p.period,
            value: p.value,
          }));
          const pathD = svgPts
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
            .join(' ');
          const cls = SERIES_CLASSES[si % SERIES_CLASSES.length];

          return (
            <g key={si} className={`ts-series ${cls}`}>
              <path d={pathD} className="ts-line" />
              {svgPts.map((p, pi) => (
                <circle key={pi} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r={3} className="ts-dot">
                  <title>
                    {p.period != null ? `${p.period}: ` : ''}
                    {p.value}
                  </title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>

      {truncated && (
        <p className="report-block__truncated-note">
          Показани са само първите резултати — данните са отрязани.
        </p>
      )}

      {/* Multi-series colour legend — must be last child of <figure> (HTML spec). */}
      {allSeries.length > 1 && (
        <figcaption className="timeseries-block__legend">
          {allSeries.map((s, si) => (
            <span
              key={si}
              className={`ts-legend-item ${SERIES_CLASSES[si % SERIES_CLASSES.length]}`}
            >
              {s.label}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}
