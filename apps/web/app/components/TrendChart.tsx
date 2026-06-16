import type { TrendPoint } from '@sigma/api-contract';

// Server-rendered area + line of spend over time (no chart JS, like SankeyDiagram). The accessible
// data is the per-year table beside it; this SVG is a visual summary (role="img" + aria-label) with
// year labels on the x-axis. Single oklch series matching the palette.
const W = 760;
const H = 240;
const PAD_B = 22; // room under the line for year labels
const PAD_T = 10;

export function TrendChart({
  points,
  granularity,
}: {
  points: TrendPoint[];
  granularity: 'month' | 'year';
}) {
  if (points.length < 2) return null;
  const max = Math.max(1, ...points.map((p) => p.valueEur));
  const n = points.length;
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => H - PAD_B - (v / max) * (H - PAD_B - PAD_T);
  const line = points
    .map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.valueEur).toFixed(1)}`)
    .join('');
  const area = `${line}L${x(n - 1).toFixed(1)},${H - PAD_B}L0,${H - PAD_B}Z`;
  // x-axis ticks at the first month of each year (month granularity) or at every point (year).
  const ticks = points
    .map((p, i) => ({ i, year: p.period.slice(0, 4) }))
    .filter((t, idx) => granularity === 'year' || points[idx]!.period.endsWith('-01'));

  return (
    <svg
      viewBox={`-14 0 ${W + 28} ${H}`}
      role="img"
      aria-label="Разходи за обществени поръчки във времето"
      style={{ width: '100%', height: 'auto', display: 'block' }}
    >
      {ticks.map((t) => (
        <line
          key={`g${t.i}`}
          x1={x(t.i)}
          y1={PAD_T}
          x2={x(t.i)}
          y2={H - PAD_B}
          style={{ stroke: '#eceae4', strokeWidth: 1 }}
        />
      ))}
      <path d={area} style={{ fill: 'oklch(0.62 0.13 250 / 0.16)' }} />
      <path d={line} style={{ fill: 'none', stroke: 'oklch(0.5 0.16 250)', strokeWidth: 1.5 }} />
      {ticks.map((t) => (
        <text
          key={`t${t.i}`}
          x={x(t.i)}
          y={H - 6}
          textAnchor="middle"
          style={{ font: '11px var(--font-mono, monospace)', fill: 'var(--ink-soft, #555)' }}
        >
          {t.year}
        </text>
      ))}
    </svg>
  );
}
