import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { drag } from 'd3-drag';
import { select } from 'd3-selection';
import { zoom, type ZoomBehavior, zoomIdentity } from 'd3-zoom';
import type { NetworkData, NetworkNode } from '@sigma/api-contract';
import {
  clampToBounds,
  forceConfig,
  GEOMETRY,
  ringRadius,
  seedPositions,
  type Geometry,
  type Pt,
} from './network-layout';

// Progressive-enhancement hook: the d3-force / d3-drag / d3-zoom lifecycle for NetworkGraph.
//
// SSR & first client render: positions state is initialised to the DETERMINISTIC radial seed (the same
// pure layout the server used), so the hydrated DOM matches byte-for-byte and there is no mismatch.
// Only after mount does the post-mount effect below start a physics sim that animates out of that seed.
//
// The sim writes positions back through React state (setPositions) per tick rather than mutating the
// DOM imperatively: with ~15 nodes the re-render cost is negligible, and it keeps ALL the SVG geometry
// (edge endpoints, rotated value labels, label-collision guard) declarative in one place in the JSX
// instead of being duplicated as imperative attribute writes here. The sim is bounded (alphaDecay →
// alphaMin) so it settles and stops — no infinite RAF.

interface SimNode extends SimulationNodeDatum {
  id: string;
  hop: number;
  r: number;
}
type SimLink = SimulationLinkDatum<SimNode> & {
  source: string | SimNode;
  target: string | SimNode;
};

// Reduced-motion preference, extracted as plain functions so the subscription logic is unit-testable
// without mounting the hook. Shares the matchMedia-listener shape used by SiteHeader's nav-close effect.
export function initialReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function subscribeReducedMotion(onChange: (matches: boolean) => void): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  const onMqChange = (e: MediaQueryListEvent) => onChange(e.matches);
  mq.addEventListener('change', onMqChange);
  return () => mq.removeEventListener('change', onMqChange);
}

// `edges` isn't normalised by direction (centre→periphery) — the authority→company normalisation in
// `networkRows` creates new node objects without touching edge direction, so an edge's `target` isn't
// guaranteed to be the more-peripheral end. Pure so it's unit-testable without mounting the sim.
export function linkHop(link: SimLink): number {
  const source = link.source as SimNode;
  const target = link.target as SimNode;
  return Math.max(source.hop, target.hop);
}

interface Params {
  svgRef: RefObject<SVGSVGElement | null>;
  layerRef: RefObject<SVGGElement | null>;
  current: NetworkData;
  radiusOf: (n: NetworkNode) => number;
  geom?: Geometry;
}

export interface ForceGraph {
  positions: Map<string, Pt>;
  transform: string | undefined; // zoom/pan transform for the layer <g>; undefined = identity (SSR)
  draggedRef: RefObject<boolean>; // true right after a real drag → the node <a> suppresses navigation
  interactive: boolean; // false on SSR + first render; true once mounted (gates the client-only controls)
  zoomIn: () => void;
  zoomOut: () => void;
  resetView: () => void;
}

export function useForceGraph({
  svgRef,
  layerRef,
  current,
  radiusOf,
  geom = GEOMETRY,
}: Params): ForceGraph {
  const seed = useMemo(() => seedPositions(current.nodes, current.edges, geom), [current, geom]);

  const [positions, setPositions] = useState<Map<string, Pt>>(seed);
  const [transform, setTransform] = useState<string | undefined>(undefined);

  // When the browsed network changes, snap synchronously back to the new static seed (and identity
  // zoom) BEFORE the sim re-inits — the React "adjust state on prop change" pattern. This is also what
  // keeps the first paint of a re-centred graph identical to its server-rendered static layout.
  const seedRef = useRef(seed);
  if (seedRef.current !== seed) {
    seedRef.current = seed;
    setPositions(seed);
    setTransform(undefined);
  }

  // Tracked live (not read once) so a user flipping the OS/browser preference mid-session is honoured
  // without a full re-mount — see subscribeReducedMotion above.
  const [reduceMotion, setReduceMotion] = useState(initialReducedMotion);
  useEffect(() => subscribeReducedMotion(setReduceMotion), []);

  const draggedRef = useRef(false);
  // Gate the client-only zoom controls: false on SSR + first render (so hydration matches), true after
  // mount. The zoom behaviour is stashed in a ref so the button callbacks can drive it imperatively.
  const [interactive, setInteractive] = useState(false);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  useEffect(() => setInteractive(true), []);

  const zoomBy = useCallback(
    (k: number) => {
      const el = svgRef.current;
      if (el && zoomRef.current) zoomRef.current.scaleBy(select(el), k);
    },
    [svgRef],
  );
  const zoomIn = useCallback(() => zoomBy(1.3), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / 1.3), [zoomBy]);
  const resetView = useCallback(() => {
    const el = svgRef.current;
    if (el && zoomRef.current) zoomRef.current.transform(select(el), zoomIdentity);
  }, [svgRef]);

  useEffect(() => {
    const svgEl = svgRef.current;
    const layerEl = layerRef.current;
    if (!svgEl || !layerEl) return;

    const cfg = forceConfig(geom);

    // Copies only — never mutate the NetworkData props (d3 writes x/y/vx/vy/fx/fy onto these objects).
    const simNodes: SimNode[] = current.nodes.map((n) => {
      const p = seed.get(n.id) ?? { x: geom.CX, y: geom.CY };
      const node: SimNode = { id: n.id, hop: n.hop, r: radiusOf(n), x: p.x, y: p.y };
      if (n.hop === 0) {
        node.fx = geom.CX; // centre fixed at the centre
        node.fy = geom.CY;
      }
      return node;
    });
    const byId = new Map(simNodes.map((n) => [n.id, n] as const));
    const simLinks: SimLink[] = current.edges
      .filter((e) => byId.has(e.from) && byId.has(e.to))
      .map((e) => ({ source: e.from, target: e.to }));

    const writePositions = () => {
      const next = new Map<string, Pt>();
      for (const n of simNodes) {
        const c = clampToBounds({ x: n.x ?? geom.CX, y: n.y ?? geom.CY }, n.r, geom);
        n.x = c.x;
        n.y = c.y;
        next.set(n.id, c);
      }
      setPositions(next);
    };

    const sim = forceSimulation(simNodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance((l) => cfg.linkDistance(linkHop(l)))
          .strength(cfg.linkStrength),
      )
      .force('charge', forceManyBody<SimNode>().strength(cfg.charge))
      .force(
        'collide',
        forceCollide<SimNode>((d) => d.r + cfg.collidePad),
      )
      .force(
        'radial',
        forceRadial<SimNode>((d) => ringRadius(d.hop, geom), geom.CX, geom.CY).strength(
          cfg.radialStrength,
        ),
      )
      .velocityDecay(cfg.velocityDecay)
      .alphaDecay(cfg.alphaDecay)
      .alphaMin(cfg.alphaMin);

    // Register the tick repaint ALWAYS — even under reduced-motion — so a user-initiated drag (which
    // restarts the sim) still updates the DOM. `tick()` called manually below does NOT dispatch this
    // event, so the reduced-motion settle stays animation-free; only the timer (drag/restart) fires it.
    sim.on('tick', writePositions);
    if (reduceMotion) {
      // Respect reduced-motion: settle synchronously, paint once, and stop the auto-animation timer.
      for (let i = 0; i < 400 && sim.alpha() > cfg.alphaMin; i++) sim.tick();
      writePositions();
      sim.stop();
    }

    // Drag a non-centre node. container = the layer <g> so d3 reports coordinates in the graph's own
    // space (zoom/pan already accounted for). A move flips draggedRef so the node's <a> onClick can
    // cancel navigation; a pure click (no move) leaves it false and still re-centres.
    const dragBehaviour = drag<Element, unknown, SimNode>()
      .container(() => layerEl)
      // A tremor/tap under ~4px counts as a click (lets re-centre fire); past it, d3 suppresses the
      // synthetic click and it's a drag.
      .clickDistance(4)
      .subject((event) => {
        const id = (event.sourceEvent.target as Element)
          .closest('[data-node-id]')
          ?.getAttribute('data-node-id');
        // Drag is only bound to real node anchors, so this resolves; if it ever doesn't, d3 sees
        // `undefined` and simply cancels the gesture (the `!` only quiets the strict Subject type).
        return byId.get(id ?? '')!;
      })
      .on('start', (event) => {
        draggedRef.current = false;
        if (!event.active) sim.alphaTarget(0.3).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      })
      .on('drag', (event) => {
        draggedRef.current = true;
        event.subject.fx = event.x;
        event.subject.fy = event.y;
      })
      .on('end', (event) => {
        if (!event.active) sim.alphaTarget(0);
        if (event.subject.hop !== 0) {
          event.subject.fx = null; // release (centre stays pinned)
          event.subject.fy = null;
        }
      });

    // Pan via background drag; zoom via ctrl/⌘+wheel and trackpad pinch (which the browser delivers as
    // a ctrlKey wheel). Requiring the modifier means a plain wheel still scrolls the PAGE rather than
    // being trapped by the graph. Gestures starting on a node are filtered out so node-drag wins. The
    // transform composes on top of the existing viewBox in the same user-space coordinate system.
    const zoomBehaviour = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 4])
      .filter((event) => {
        if (event.type === 'wheel') return event.ctrlKey || event.metaKey;
        const target = event.target as Element;
        return !target.closest('[data-node-id]');
      })
      .on('zoom', (event) => setTransform(event.transform.toString()));

    const svgSel = select(svgEl);
    const nodeSel = select(layerEl).selectAll<Element, unknown>('[data-draggable="1"]');
    nodeSel.call(dragBehaviour);
    svgSel.call(zoomBehaviour);
    // d3-zoom stores its transform on the SVG node (svgEl.__zoom); React state alone can't reset it.
    // Sync it to identity on (re)init so a browse re-centre — which resets the React transform — doesn't
    // leave d3 holding the previous graph's pan/zoom (which would jump on the next gesture).
    zoomBehaviour.transform(svgSel, zoomIdentity);
    zoomRef.current = zoomBehaviour; // expose to the +/−/reset button callbacks

    return () => {
      sim.on('tick', null);
      sim.stop();
      nodeSel.on('.drag', null);
      svgSel.on('.zoom', null);
      zoomRef.current = null;
    };
    // radiusOf is memoised by the caller per `current`; seed is derived from `current`.
  }, [current, seed, geom, radiusOf, svgRef, layerRef, reduceMotion]);

  return { positions, transform, draggedRef, interactive, zoomIn, zoomOut, resetView };
}
