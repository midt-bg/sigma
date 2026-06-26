import { useEffect, useRef, useState } from 'react';
import { useFetcher } from 'react-router';
import type { NetworkData, NetworkNode } from '@sigma/api-contract';
import { count, money, moneyBare } from '@sigma/shared';
import { centerToken, isAdoptableNetwork } from '../lib/network-center';

// Server-rendered radial ego graph (no chart JS, like SankeyDiagram). Centre in the middle, direct
// counterparties on an inner ring, their top other counterparty on an outer ring. Node size is the sum
// of incident edge values; edge thickness is the flow value. Each edge carries a midpoint value label
// (toggled by a pure-CSS checkbox).
//
// Progressive enhancement — the URL never changes while you browse:
//  • No JS (SSR / crawlers): each non-centre node is a plain <a> to that entity's profile page.
//  • With JS (hydrated): clicking a node RE-CENTRES the graph in place — it fetches that node's own
//    ego-network from the /network loader (the canonical network-data route) via useFetcher and
//    redraws, leaving the URL untouched. Two controls then appear: "Отвори профила" jumps to the
//    focused node's page, and "Върни се в началото" resets the graph to the entity the URL points at.
//    The accessible navigation path is the connections table beside the graph (its cells are links);
//    this SVG is a visual summary (role="img").
const W = 820;
const H = 600;
const CX = W / 2;
const CY = H / 2;
const R1 = 170;
const R2 = 300;
const LABEL_GAP = 17; // min vertical px between two node labels on the same side (collision guard)
// Palette tokens only: the centre is the accent, authorities and companies sit on the ink scale and
// are told apart by shape (circle vs square) + the legend, not by an off-palette blue/green pair.
const CENTER_FILL = 'var(--accent)'; // centre (focus)
const AUTH_FILL = 'var(--ink)'; // authorities
const COMP_FILL = 'var(--ink-mid)'; // companies

function truncate(s: string, n = 22): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Each non-centre node's profile (hero) page — the no-JS click target and the "Open" button target.
// (centerToken — the `?center` grammar — is shared with the loader via ../lib/network-center.)
const heroHref = (n: { kind: string; slug: string }) =>
  n.kind === 'authority' ? `/authorities/${n.slug}` : `/companies/${n.slug}`;

export function NetworkGraph({ data }: { data: NetworkData }) {
  // `data` is the root ego-network the page rendered server-side (matches the URL). When the user
  // browses, we hold the re-centred network here; null = showing the root.
  const fetcher = useFetcher<{ data: NetworkData }>();
  const [browsed, setBrowsed] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  // True between a node click and the adoption of its result. Lets Reset cancel an in-flight load so a
  // late-arriving fetch can't snap the graph back, and stops us re-adopting stale fetcher.data.
  const pending = useRef(false);
  const resetRef = useRef<HTMLButtonElement>(null);

  // The component stays mounted across navigations (RR does not remount on a param/route change), so a
  // stale `browsed` would otherwise survive a dropdown change on /network or a hop between profiles.
  // Reset it whenever the page's root network changes.
  useEffect(() => {
    setBrowsed(null);
    setFailed(false);
    pending.current = false;
  }, [data]);

  // Adopt a completed re-centre — but only if it's still wanted (Reset clears `pending`) and valid
  // (has a centre and ≥2 nodes, so the render guard below can never strip the component mid-session).
  useEffect(() => {
    if (!pending.current || fetcher.state !== 'idle') return;
    pending.current = false;
    const next = fetcher.data?.data;
    if (next && isAdoptableNetwork(next)) {
      setBrowsed(next);
      setFailed(false);
    } else {
      setFailed(true);
    }
  }, [fetcher.state, fetcher.data]);

  // After adopting a re-centre, move keyboard focus to Reset (the way back) so focus isn't lost to
  // <body> when the clicked node is replaced by the non-interactive centre.
  useEffect(() => {
    if (browsed) resetRef.current?.focus();
  }, [browsed]);

  const current = browsed ?? data;
  const loading = fetcher.state === 'loading';
  const recentred = Boolean(current.center && data.center && current.center.id !== data.center.id);

  const { nodes, edges, center } = current;
  // Defensive guard so the component is safe on its own; callers also gate on the same condition.
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

  // Collision guard for node labels: labels are anchored to the left or right of their node, so two
  // nodes close in y on the same side would overlap. Within each side, sort by y and push each label
  // down until it clears the previous one by LABEL_GAP. Deterministic, server-renderable (no measuring).
  const labelY = new Map<string, number>();
  for (const rightSide of [false, true]) {
    const side = [...pos.entries()]
      .filter(([, p]) => (rightSide ? p.x >= CX : p.x < CX))
      .sort((a, b) => a[1].y - b[1].y);
    let prev = -Infinity;
    for (const [id, p] of side) {
      const y = Math.max(p.y, prev + LABEL_GAP);
      labelY.set(id, y);
      prev = y;
    }
  }

  const maxVal = Math.max(1, ...nodes.map((n) => n.valueEur));
  const radius = (n: NetworkNode) => 6 + Math.sqrt(n.valueEur / maxVal) * 22;
  const maxEdge = Math.max(1, ...edges.map((e) => e.valueEur));
  const strokeW = (v: number) => 1 + (v / maxEdge) * 5;
  const fill = (n: NetworkNode) =>
    n.hop === 0 ? CENTER_FILL : n.kind === 'authority' ? AUTH_FILL : COMP_FILL;

  // Re-centre on a node without navigating: load that node's ego-network from the /network loader.
  const recentre = (n: NetworkNode) => {
    setFailed(false);
    pending.current = true;
    fetcher.load(`/network?center=${centerToken(n)}`);
  };
  const reset = () => {
    pending.current = false;
    setFailed(false);
    setBrowsed(null);
  };

  return (
    <div className="net-graph" aria-busy={loading || undefined}>
      <div className="net-controls">
        {/* Pure-CSS toggle: when unchecked, `.net-graph:has(input:not(:checked)) .edge-label` hides the
            midpoint value labels — no client JS needed for this part. Default on. */}
        <label className="net-toggle">
          <input type="checkbox" defaultChecked />
          Стойности по връзките
        </label>
        {recentred ? (
          <span className="net-actions">
            {/* Focused on {center.label} — jump to its page, or reset back to the URL's entity. */}
            <a className="net-btn" href={heroHref(center)}>
              Отвори профила →
            </a>
            <button ref={resetRef} type="button" className="net-btn net-btn-ghost" onClick={reset}>
              Върни се в началото
            </button>
          </span>
        ) : (
          <span className="net-hint" aria-hidden="true">
            Клик върху възел пренасочва графа
          </span>
        )}
        {loading && (
          <span className="net-loading" role="status">
            Зареждане…
          </span>
        )}
        {failed && !loading && (
          <span className="net-error" role="status">
            Връзката не можа да се зареди. Опитай пак.
          </span>
        )}
      </div>
      {/* Sankey-style horizontal scroll so the fixed-width graph does not squash on phones; the
          connections table below is the accessible fallback. */}
      <div className="flow-scroll">
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
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const L = Math.hypot(dx, dy) || 1;
            // Rotate the value label to lie along the edge, kept upright (never upside-down), and nudged
            // off the line along its perpendicular so the number does not sit on top of the stroke.
            let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
            if (deg > 90) deg -= 180;
            else if (deg < -90) deg += 180;
            // Bias the label toward the OUTER node (`to` is always the more-peripheral endpoint) so the
            // labels of the spokes radiating from the hub fan out instead of piling up on the centre,
            // and nudge it off the line along the perpendicular.
            const t = 0.62;
            const off = 10;
            const lx = a.x + dx * t + (-dy / L) * off;
            const ly = a.y + dy * t + (dx / L) * off;
            return (
              <g key={`e${i}`}>
                <line
                  className="edge"
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  style={{ strokeWidth: strokeW(e.valueEur) }}
                >
                  <title>{`${money(e.valueEur)} · ${count(e.contracts)} ${
                    e.contracts === 1 ? 'договор' : 'договора'
                  }`}</title>
                </line>
                <text
                  className="edge-label"
                  x={lx}
                  y={ly}
                  textAnchor="middle"
                  dominantBaseline="central"
                  transform={`rotate(${deg} ${lx} ${ly})`}
                >
                  {moneyBare(e.valueEur)}
                </text>
              </g>
            );
          })}
          {nodes.map((n) => {
            const pt = pos.get(n.id);
            if (!pt) return null;
            const r = radius(n);
            const right = pt.x >= CX;
            const isCenter = n.hop === 0;
            const title = `${n.label}: ${money(n.valueEur)}`;
            const shape =
              n.kind === 'company' ? (
                <rect
                  className="node"
                  x={pt.x - r}
                  y={pt.y - r}
                  width={r * 2}
                  height={r * 2}
                  rx={3}
                  style={{ fill: fill(n) }}
                >
                  <title>{title}</title>
                </rect>
              ) : (
                <circle className="node" cx={pt.x} cy={pt.y} r={r} style={{ fill: fill(n) }}>
                  <title>{title}</title>
                </circle>
              );
            const text = (
              <text
                className="node-label"
                x={right ? pt.x + r + 4 : pt.x - r - 4}
                y={(labelY.get(n.id) ?? pt.y) + 3}
                textAnchor={right ? 'start' : 'end'}
              >
                {truncate(n.label)}
              </text>
            );
            // Centre node is the current focus → not a link. It also carries NO text label: it is
            // already named in the page title, the centre dropdown and the legend (the only accent
            // node), and a label here would collide with a neighbour or sit on an edge (aligns with
            // #124). Every other node is an anchor to its profile page (the no-JS fallback); with JS
            // the click is intercepted and re-centres the graph in place ("Отвори профила" follows it).
            return isCenter ? (
              <g key={n.id}>{shape}</g>
            ) : (
              <a
                key={n.id}
                href={heroHref(n)}
                aria-label={`Пренасочи графа към ${n.label}`}
                onClick={(ev) => {
                  // Honour new-tab / modifier clicks → let the browser follow the href.
                  if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0)
                    return;
                  ev.preventDefault();
                  recentre(n);
                }}
              >
                {shape}
                {text}
              </a>
            );
          })}
        </svg>
      </div>
      <ul className="net-legend" aria-hidden="true">
        <li>
          <span className="key center" /> Център
        </li>
        <li>
          <span className="key authority" /> Институция
        </li>
        <li>
          <span className="key company" /> Фирма
        </li>
      </ul>
    </div>
  );
}
