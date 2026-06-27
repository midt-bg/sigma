import { useCallback, useEffect, useRef, useState } from 'react';
import { useFetcher } from 'react-router';
import type { NetworkData, NetworkNode } from '@sigma/api-contract';
import { count, money, moneyBare } from '@sigma/shared';
import { centerToken, isAdoptableNetwork } from '../lib/network-center';
import { GEOMETRY, labelPositions } from '../lib/network-layout';
import { useForceGraph } from '../lib/useForceGraph';

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
//
// Progressive enhancement (issue #142): on hydration a d3-force sim animates out of the deterministic
// static seed, with d3-drag to move nodes and d3-zoom to pan/zoom. The SSR / no-JS render is unchanged
// — same static positions, same <a> fallbacks; the physics only ever starts in a post-mount effect
// (see useForceGraph). The drawing geometry (radius, ring radii, seed, label collision) lives in
// ../lib/network-layout so SSR and the sim seed share one source of truth.
const { W, H, CX } = GEOMETRY;
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
  // Hover-to-explore: which node the pointer is over (drives the side Information Card + the focus/dim
  // emphasis). Cleared on mouse-leave; a stale id from a previous graph self-corrects (see `hovering`).
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Full-screen toggle for the whole widget (controls + graph + card stay usable inside it).
  const [isFullscreen, setIsFullscreen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
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

  // Keep the button label/state in sync with the actual fullscreen status (covers Esc / browser exit).
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const current = browsed ?? data;
  const loading = fetcher.state === 'loading';
  const recentred = Boolean(current.center && data.center && current.center.id !== data.center.id);

  const { nodes, edges, center, counterpartyTotal } = current;
  // The graph only draws the top few direct counterparties (HOP1) for readability. Count how many are
  // actually drawn and, when the centre has more, say so plainly rather than letting the cap read as
  // "this is all there is" — the full list lives in the relations table on /network.
  const directShown = center ? edges.filter((e) => e.from === center.id).length : 0;
  const truncated = counterpartyTotal > directShown;

  const maxVal = Math.max(1, ...nodes.map((n) => n.valueEur));
  // Stable per `current` so the force effect (which depends on it) doesn't re-init every render/tick.
  const radius = useCallback((n: NetworkNode) => 6 + Math.sqrt(n.valueEur / maxVal) * 22, [maxVal]);

  // Progressive enhancement: SSR + first client render use `positions` seeded to the deterministic
  // static layout; after mount the d3 sim animates out of it and drag/zoom take over. `transform` is
  // the zoom/pan transform for the layer <g> (undefined = identity, the SSR state). `draggedRef` lets a
  // node's <a> onClick distinguish a click (navigate / re-centre) from a drag (do nothing).
  const svgRef = useRef<SVGSVGElement | null>(null);
  const layerRef = useRef<SVGGElement | null>(null);
  const { positions, transform, draggedRef, interactive, zoomIn, zoomOut, resetView } =
    useForceGraph({
      svgRef,
      layerRef,
      current,
      radiusOf: radius,
    });

  // Defensive guard so the component is safe on its own; callers also gate on the same condition.
  // NOTE: hooks above always run (no early return before them) so hook order stays stable.
  if (!center || nodes.length < 2) return null;

  const pos = positions;
  const labelY = labelPositions(pos);

  // Hover emphasis: the focused node + its direct neighbours stay lit, everything else dims, and the
  // side card shows the focused node. `hovering` is true only for a node that exists in the CURRENT
  // graph, so a stale id left from a browse can never dim the whole graph.
  const hoveredNode = hoveredId ? (nodes.find((n) => n.id === hoveredId) ?? null) : null;
  const hovering = Boolean(hoveredNode);
  const adjacent = new Set<string>();
  if (hoveredNode) {
    adjacent.add(hoveredNode.id);
    for (const e of edges) {
      if (e.from === hoveredNode.id) adjacent.add(e.to);
      if (e.to === hoveredNode.id) adjacent.add(e.from);
    }
  }
  const hoveredDegree = hoveredNode
    ? edges.filter((e) => e.from === hoveredNode.id || e.to === hoveredNode.id).length
    : 0;
  const nodeClass = (id: string) =>
    hovering && !adjacent.has(id) ? 'is-dim' : id === hoveredId ? 'is-focus' : undefined;
  const edgeDimmed = (e: { from: string; to: string }) =>
    Boolean(hoveredNode && e.from !== hoveredNode.id && e.to !== hoveredNode.id);

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
  // Expand the whole widget to fill the screen (and back). The Fullscreen API needs a user gesture,
  // which the button click provides; the `fullscreenchange` effect above keeps `isFullscreen` honest.
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else wrapRef.current?.requestFullscreen?.();
  };

  return (
    <div className="net-graph" aria-busy={loading || undefined} ref={wrapRef}>
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
            {interactive
              ? 'Клик пренасочва · влачи възел · бутоните мащабират'
              : 'Клик върху възел пренасочва графа'}
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
      {/* Graph + side Information Card (mirrors /map). The card fills on hover; the graph dims all but
          the focused node and its neighbours. Wraps to a single column on narrow screens. */}
      <div className="net-explore">
        {/* Sankey-style horizontal scroll so the fixed-width graph does not squash on phones; the
            connections table below is the accessible fallback. */}
        <div className="flow-scroll net-canvas">
          {/* Client-only zoom controls (discoverable, keyboard-accessible). Hidden until hydrated so SSR
              doesn't render dead buttons. Pan = drag background; node drag = move; ctrl/⌘+wheel also zooms. */}
          {interactive && (
            <div className="net-zoom" role="group" aria-label="Мащаб на графа">
              <button type="button" aria-label="Намали" onClick={zoomOut}>
                −
              </button>
              <button type="button" aria-label="Нагласи изгледа" onClick={resetView}>
                ↺
              </button>
              <button type="button" aria-label="Увеличи" onClick={zoomIn}>
                +
              </button>
              <button
                type="button"
                aria-label={isFullscreen ? 'Изход от цял екран' : 'Цял екран'}
                aria-pressed={isFullscreen}
                onClick={toggleFullscreen}
              >
                {isFullscreen ? '⤡' : '⤢'}
              </button>
            </div>
          )}
          <svg
            ref={svgRef}
            viewBox={`-100 -10 ${W + 200} ${H + 20}`}
            role="img"
            aria-label={`Граф на връзките около ${center.label}`}
            className={`network-svg${interactive ? ' is-interactive' : ''}${hovering ? ' is-hovering' : ''}`}
            onMouseLeave={() => setHoveredId(null)}
          >
            {/* Everything lives in one layer <g> so d3-zoom can pan/zoom it via a transform that simply
              composes on top of the SVG's viewBox. transform is undefined server-side (identity), so the
              hydrated markup matches the SSR output. */}
            <g ref={layerRef} transform={transform}>
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
                // A near-vertical edge would rotate the label to read bottom-to-top (and clip against the
                // viewBox), so for steep edges keep the text horizontal and push it further to the side.
                const steep = Math.abs(deg) > 55;
                // Bias the label toward the OUTER node (`to` is always the more-peripheral endpoint) so the
                // labels of the spokes radiating from the hub fan out instead of piling up on the centre,
                // and nudge it off the line along the perpendicular.
                const t = 0.62;
                const off = steep ? 24 : 10;
                const lx = a.x + dx * t + (-dy / L) * off;
                const ly = a.y + dy * t + (dx / L) * off;
                return (
                  <g key={`e${i}`} className={edgeDimmed(e) ? 'is-dim' : undefined}>
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
                      transform={steep ? undefined : `rotate(${deg} ${lx} ${ly})`}
                    >
                      {moneyBare(e.valueEur)}
                      {/* Append the contract count only when >1 (a single contract is the common case
                          and the suffix would just clutter the edge). Abbreviated „дог." to stay short;
                          the full „N договора" is in the edge's hover <title> above. */}
                      {e.contracts > 1 ? ` (${count(e.contracts)} дог.)` : ''}
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
                  <g key={n.id} className={nodeClass(n.id)} onMouseEnter={() => setHoveredId(n.id)}>
                    {shape}
                  </g>
                ) : (
                  <a
                    key={n.id}
                    href={heroHref(n)}
                    aria-label={`Пренасочи графа към ${n.label}`}
                    data-node-id={n.id}
                    data-draggable="1"
                    className={nodeClass(n.id)}
                    onMouseEnter={() => setHoveredId(n.id)}
                    onClick={(ev) => {
                      // A drag just ended on this node → it was a move, not a click. Swallow the synthetic
                      // click so dragging never navigates / re-centres. (Set by d3-drag in useForceGraph.)
                      if (draggedRef.current) {
                        draggedRef.current = false;
                        ev.preventDefault();
                        return;
                      }
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
            </g>
          </svg>
        </div>
        {/* Side Information Card — fills on hover (like /map's). The connections table below stays the
            keyboard/AT path; this is a sighted-only convenience. */}
        <aside className="net-card">
          {hoveredNode ? (
            <>
              <h3 className="net-card-title">{hoveredNode.label}</h3>
              <p className="net-card-sub muted">
                {hoveredNode.hop === 0
                  ? 'Център'
                  : hoveredNode.kind === 'authority'
                    ? 'Институция'
                    : 'Фирма'}
              </p>
              <dl className="net-card-stats">
                <div>
                  <dt>Стойност в графа</dt>
                  <dd>{money(hoveredNode.valueEur)}</dd>
                </div>
                <div>
                  <dt>Връзки в графа</dt>
                  <dd>{count(hoveredDegree)}</dd>
                </div>
              </dl>
              {hoveredNode.hop !== 0 && (
                <p className="net-card-actions">
                  <a className="net-btn" href={heroHref(hoveredNode)}>
                    Отвори профила →
                  </a>
                </p>
              )}
            </>
          ) : (
            <p className="net-card-hint muted">Посочи възел на графа, за да видиш детайли.</p>
          )}
        </aside>
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
      {truncated && center && (
        <p className="net-caption muted">
          Графиката показва {count(directShown)} от общо {count(counterpartyTotal)} преки
          контрагента (най-големите по стойност).{' '}
          <a href={`/network?center=${encodeURIComponent(centerToken(center))}#counterparties`}>
            Виж всички
          </a>
          .
        </p>
      )}
    </div>
  );
}
