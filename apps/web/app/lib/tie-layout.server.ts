import * as dagreModule from '@dagrejs/dagre';
import type { CompanyTieKind, CompanyTieNetwork } from '@sigma/api-contract';
import type { TieLayout, TieLayoutEdge, TieLayoutNode } from './tie-layout';

// The layered layout of the tie graph: the engine Mermaid uses for flowcharts, run here in the Worker
// at render time, so the page ships a finished SVG and no layout code. The institutions that pay the centre
// stand to its left, the centre in the middle, the companies tied to it to its right — boxes with the name
// inside and the kind of tie written on each edge.

// dagre is CommonJS: an ES import sees its exports on `default` under Node and on the namespace itself
// after the bundler's interop.
const dagre = (dagreModule as unknown as { default?: typeof dagreModule }).default ?? dagreModule;

const CHAR_W = 6.6; // ≈ one character of 11px mono
const PAD_X = 24;
const MIN_W = 110;
const MAX_W = 230;
const BOX_H = 34;
const CENTER_H = 42;
const EDGE_CHAR_W = 5.8; // ≈ one character of 10px mono
const EDGE_LABEL_H = 14;

/** What each kind of tie is called on its edge — short, the table and the tooltip carry the full sentence. */
export const TIE_EDGE_LABEL: Record<CompanyTieKind, string> = {
  consortium: 'обединение',
  subcontract: 'подизпълнител',
  declared_stake: 'общо свързано лице',
  money: 'плаща',
};

const MAX_CHARS = Math.floor((MAX_W - PAD_X) / CHAR_W);

/** A name as drawn in its box: whole when it fits the widest box, else cut with an ellipsis. */
export function boxLabel(name: string): string {
  return name.length > MAX_CHARS ? `${name.slice(0, MAX_CHARS - 1)}…` : name;
}

const boxWidth = (label: string) =>
  Math.min(MAX_W, Math.max(MIN_W, Math.round(label.length * CHAR_W) + PAD_X));
const round = (v: number) => Math.round(v * 10) / 10;

/** Lay the network out, or null when there is nothing to draw (no centre, or the centre alone). */
export function layoutTies(net: CompanyTieNetwork): TieLayout | null {
  const { center, nodes, edges } = net;
  if (!center || nodes.length < 2) return null;
  const ids = new Set(nodes.map((n) => n.id));

  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'LR', nodesep: 14, ranksep: 64, edgesep: 10, marginx: 8, marginy: 8 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    const label = boxLabel(n.label);
    g.setNode(n.id, {
      width: boxWidth(label),
      height: n.id === center.id ? CENTER_H : BOX_H,
    });
  }
  // An edge to a node it was not given is skipped, never drawn to a node the layout would invent.
  const drawn = edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  // Ranked by where things stand, not by the tie's own direction: a tie that touches the centre points away
  // from it (a payer points into it), so the centre is one column and its ties the next.
  const ranked = drawn.map((e) =>
    e.kind !== 'money' && e.to === center.id ? { v: e.to, w: e.from } : { v: e.from, w: e.to },
  );
  const labelWidth = (e: CompanyTieNetwork['edges'][number]) =>
    Math.round(TIE_EDGE_LABEL[e.kind].length * EDGE_CHAR_W) + 8;
  drawn.forEach((e, i) => {
    g.setEdge(
      ranked[i]!.v,
      ranked[i]!.w,
      { width: labelWidth(e), height: EDGE_LABEL_H, labelpos: 'c' },
      `e${i}`,
    );
  });
  dagre.layout(g);

  const layoutNodes: TieLayoutNode[] = nodes.map((n) => {
    const p = g.node(n.id);
    return {
      id: n.id,
      kind: n.kind,
      name: n.label,
      label: boxLabel(n.label),
      href: n.kind === 'authority' ? `/authorities/${n.slug}` : `/companies/${n.slug}`,
      valueEur: n.valueEur,
      center: n.id === center.id,
      x: round(p.x),
      y: round(p.y),
      width: p.width,
      height: p.height,
    };
  });
  const layoutEdges: TieLayoutEdge[] = drawn.map((e, i) => {
    const { v, w } = ranked[i]!;
    const d = g.edge(v, w, `e${i}`);
    const points = d.points.map((p) => ({ x: round(p.x), y: round(p.y) }));
    return {
      ...e,
      // dagre routes v → w; turned back where that ran against the tie, so the arrow sits on `to`.
      points: v === e.from ? points : points.reverse(),
      label: {
        text: TIE_EDGE_LABEL[e.kind],
        x: round(d.x ?? 0),
        y: round(d.y ?? 0),
        width: labelWidth(e),
      },
    };
  });
  const size = g.graph();
  return {
    width: Math.ceil(size.width ?? 0),
    height: Math.ceil(size.height ?? 0),
    centerName: center.label,
    nodes: layoutNodes,
    edges: layoutEdges,
  };
}
