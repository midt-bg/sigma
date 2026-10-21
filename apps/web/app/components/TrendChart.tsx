import type { TrendPoint } from '@sigma/api-contract';
import { money, monthYear } from '@sigma/shared';

// Server-rendered area + line of spend over time (no chart JS, like SankeyDiagram). The accessible
// data is the per-year table beside it; this SVG is a visual summary (role="img" + aria-label).
// Single oklch series matching the palette. The words — the year axis and the „частично" notes —
// are HTML laid over the picture, not SVG text: SVG text shrinks with the drawing (to 4–7 px on a
// phone) and does not grow with zoom or a larger default font, HTML text in rem does both.
const PAD_B = 6;
const PAD_T = 28;

export function TrendChart({
  points,
  granularity,
  compact = false,
}: {
  points: TrendPoint[];
  granularity: 'month' | 'year';
  compact?: boolean;
}) {
  const W = compact ? 460 : 760;
  const H = compact ? 180 : 240;
  if (points.length < 2) return null;
  const max = Math.max(1, ...points.map((p) => p.valueEur));
  const n = points.length;
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => H - PAD_B - (v / max) * (H - PAD_B - PAD_T);
  const xy = (i: number) => `${x(i).toFixed(1)},${y(points[i]!.valueEur).toFixed(1)}`;
  // The final period is partial (still filling). Draw the solid line/area only up to the last complete
  // point and the tail into the partial point dashed, so its dip is not read as a real decline.
  const partialIdx = points.findIndex((p) => p.partial);
  const hasPartial = partialIdx > 0;
  const solidEnd = hasPartial ? partialIdx - 1 : n - 1;
  // The periods of the first year, while the source was being taken up, are partial too: the line runs
  // dashed from them into the first full period, so their low level is not read as a real rise after.
  let headEnd = -1;
  while (headEnd + 1 < n && points[headEnd + 1]!.partialStart) headEnd += 1;
  const hasHead = headEnd >= 0 && headEnd < n - 1;
  const solidStart = hasHead ? headEnd + 1 : 0;
  const path = (from: number, to: number) =>
    points
      .slice(from, to + 1)
      .map((_, i) => `${i ? 'L' : 'M'}${xy(from + i)}`)
      .join('');
  const hasSolid = solidEnd >= solidStart;
  const line = hasSolid ? path(solidStart, solidEnd) : '';
  const area = hasSolid
    ? `${line}L${x(solidEnd).toFixed(1)},${H - PAD_B}L${solidStart ? x(solidStart).toFixed(1) : 0},${H - PAD_B}Z`
    : '';
  const dashed = hasPartial ? `M${xy(Math.max(solidEnd, 0))}L${xy(partialIdx)}` : '';
  const headDashed = hasHead ? path(0, solidStart) : '';
  // x-axis ticks at the first month of each year (month granularity) or at every point (year).
  const ticks = points
    .map((p, i) => ({ i, year: p.period.slice(0, 4) }))
    .filter((t, idx) => granularity === 'year' || points[idx]!.period.endsWith('-01'));

  // A monthly series has no table of its own (the tables are per year), so its peak month is named
  // in words, both on screen and in the picture's accessible name.
  const peak = points.reduce((a, b) => (b.valueEur > a.valueEur ? b : a));
  const peakText =
    granularity === 'month' && peak.valueEur > 0
      ? `Най-висок месец: ${monthYear(peak.period)} — ${money(peak.valueEur)}`
      : null;
  // viewBox carries 14px of horizontal bleed on each side so the first and last year labels, which are
  // centred on the edge ticks, are not clipped. The HTML labels are placed in percent of that box.
  const left = (i: number) => `${(((x(i) + 14) / (W + 28)) * 100).toFixed(2)}%`;
  const top = (i: number) => `${((y(points[i]!.valueEur) / H) * 100).toFixed(2)}%`;
  return (
    <figure className="trend-chart">
      {peakText && <figcaption className="trend-peak">{peakText}</figcaption>}
      <div className="trend-plot">
        <svg
          className="trend-svg"
          viewBox={`-14 0 ${W + 28} ${H}`}
          role="img"
          aria-label={`Разходи за обществени поръчки във времето${peakText ? `. ${peakText}` : ''}`}
        >
          {ticks.map((t) => (
            <line
              key={`g${t.i}`}
              x1={x(t.i)}
              y1={PAD_T}
              x2={x(t.i)}
              y2={H - PAD_B}
              className="grid"
            />
          ))}
          {hasSolid && <path className="area" d={area} />}
          {hasSolid && <path className="line" d={line} />}
          {hasHead && (
            <>
              <path className="line-partial" d={headDashed} />
              <circle className="dot-partial" cx={x(0)} cy={y(points[0]!.valueEur)} r={3} />
            </>
          )}
          {hasPartial && (
            <>
              <path className="line-partial" d={dashed} />
              <circle
                className="dot-partial"
                cx={x(partialIdx)}
                cy={y(points[partialIdx]!.valueEur)}
                r={3}
              />
            </>
          )}
        </svg>
        {hasHead && (
          <span className="label-partial" aria-hidden="true" style={{ left: left(0), top: top(0) }}>
            частично
          </span>
        )}
        {hasPartial && (
          <span
            className="label-partial is-end"
            aria-hidden="true"
            style={{ left: left(partialIdx), top: top(partialIdx) }}
          >
            частично
          </span>
        )}
      </div>
      <div className="trend-axis" aria-hidden="true">
        {ticks.map((t) => (
          <span key={`t${t.i}`} className="label" style={{ left: left(t.i) }}>
            {t.year}
          </span>
        ))}
      </div>
    </figure>
  );
}
