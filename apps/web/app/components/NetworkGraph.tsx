import type { NetworkData, NetworkNode } from '@sigma/api-contract';
import { money } from '@sigma/shared';

// Static server-rendered radial ego graph (no chart JS, like SankeyDiagram). Centre in the middle,
// direct counterparties on an inner ring, their top other counterparty on an outer ring. Node size is
// the sum of incident edge values; edge thickness is the flow value. The accessible data is the
// connections table beside it; this SVG is a visual summary (role="img" + aria-label).
const W = 760;
const H = 540;
const CX = W / 2;
const CY = H / 2;
const R1 = 150;
const R2 = 250;
const CENTER_FILL = 'oklch(0.5 0.18 30)'; // centre
const AUTH_FILL = 'oklch(0.55 0.13 250)'; // authorities (blue)
const COMP_FILL = 'oklch(0.6 0.12 150)'; // companies (green)

function truncate(s: string, n = 22): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function NetworkGraph({ data }: { data: NetworkData }) {
  const { nodes, edges, center } = data;
  // Defensive guard so the component is safe on its own; network.tsx also gates on the same condition.
  if (!center || nodes.length < 2) return null;

  const hop1 = nodes.filter((n) => n.hop === 1);
  const hop2 = nodes.filter((n) => n.hop === 2);
  const pos = new Map<string, { x: number; y: number }>([[center.id, { x: CX, y: CY }]]);
  const angleOf = new Map<string, number>();

  hop1.forEach((n, i) => {
    const a = (i / Math.max(1, hop1.length)) * Math.PI * 2 - Math.PI / 2;
    angleOf.set(n.id, a);
    pos.set(n.id, { x: CX + Math.cos(a) * R1, y: CY + Math.sin(a) * R1 });
  });

  // Place each outer node near the angle of a hop-1 neighbour it connects to (small jitter avoids
  // exact overlap when several share one parent).
  hop2.forEach((n, i) => {
    const link = edges.find(
      (e) => (e.to === n.id && angleOf.has(e.from)) || (e.from === n.id && angleOf.has(e.to)),
    );
    const parent = link ? (angleOf.has(link.from) ? link.from : link.to) : null;
    const base =
      parent != null ? (angleOf.get(parent) ?? 0) : (i / Math.max(1, hop2.length)) * Math.PI * 2;
    const a = base + (i % 2 === 0 ? 1 : -1) * 0.14 * Math.ceil(i / 2);
    pos.set(n.id, { x: CX + Math.cos(a) * R2, y: CY + Math.sin(a) * R2 });
  });

  const maxVal = Math.max(1, ...nodes.map((n) => n.valueEur));
  const radius = (n: NetworkNode) => 6 + Math.sqrt(n.valueEur / maxVal) * 22;
  const maxEdge = Math.max(1, ...edges.map((e) => e.valueEur));
  const strokeW = (v: number) => 1 + (v / maxEdge) * 5;
  const fill = (n: NetworkNode) =>
    n.hop === 0 ? CENTER_FILL : n.kind === 'authority' ? AUTH_FILL : COMP_FILL;

  return (
    <svg
      viewBox={`-100 -10 ${W + 200} ${H + 20}`}
      role="img"
      aria-label={`Граф на връзките около ${center.label}`}
      className="network-svg"
    >
      {edges.map((e, i) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        return (
          <line
            key={`e${i}`}
            className="edge"
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            style={{ strokeWidth: strokeW(e.valueEur) }}
          />
        );
      })}
      {nodes.map((n) => {
        const pt = pos.get(n.id);
        if (!pt) return null;
        const r = radius(n);
        const right = pt.x >= CX;
        return (
          <g key={n.id}>
            <circle className="node" cx={pt.x} cy={pt.y} r={r} style={{ fill: fill(n) }}>
              <title>{`${n.label}: ${money(n.valueEur)}`}</title>
            </circle>
            <text
              className="node-label"
              x={right ? pt.x + r + 4 : pt.x - r - 4}
              y={pt.y + 3}
              textAnchor={right ? 'start' : 'end'}
            >
              {truncate(n.label)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
