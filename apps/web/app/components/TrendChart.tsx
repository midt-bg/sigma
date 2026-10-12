import type { TrendPoint } from '@sigma/api-contract';

// Server-rendered area + line of spend over time (no chart JS, like SankeyDiagram). The accessible
// data is the per-year table beside it; this SVG is a visual summary (role="img" + aria-label) with
// year labels on the x-axis. Single oklch series matching the palette.
const PAD_B = 22; // room under the line for year labels
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

  // viewBox carries 14px of horizontal bleed on each side so the first and last year labels, which are
  // centred on the edge ticks, are not clipped.
  return (
    <svg
      className="trend-svg"
      viewBox={`-14 0 ${W + 28} ${H}`}
      role="img"
      aria-label="Разходи за обществени поръчки във времето"
    >
      {ticks.map((t) => (
        <line key={`g${t.i}`} x1={x(t.i)} y1={PAD_T} x2={x(t.i)} y2={H - PAD_B} className="grid" />
      ))}
      {hasSolid && <path className="area" d={area} />}
      {hasSolid && <path className="line" d={line} />}
      {hasHead && (
        <>
          <path className="line-partial" d={headDashed} />
          <circle className="dot-partial" cx={x(0)} cy={y(points[0]!.valueEur)} r={3} />
          <text
            className="label-partial"
            x={x(0)}
            y={y(points[0]!.valueEur) - 7}
            textAnchor="start"
          >
            частично
          </text>
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
          <text
            className="label-partial"
            x={x(partialIdx)}
            y={y(points[partialIdx]!.valueEur) - 7}
            textAnchor="end"
          >
            частично
          </text>
        </>
      )}
      {ticks.map((t) => (
        <text key={`t${t.i}`} x={x(t.i)} y={H - 6} textAnchor="middle" className="label">
          {t.year}
        </text>
      ))}
    </svg>
  );
}
