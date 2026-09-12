import * as dagreModule from '@dagrejs/dagre';
import type { CompanyTieEdge, CompanyTieKind, CompanyTieNetwork } from '@sigma/api-contract';
import { nodeHref, type TieLayout, type TieLayoutEdge, type TieLayoutNode } from './tie-layout';
import { roleEdgeText } from './registry-roles';

// The layered layout of the tie graph: the engine Mermaid uses for flowcharts, run here in the Worker
// at render time, so the page ships a finished SVG and no layout code. The columns follow the distance from
// the centre: the institutions that pay it stand to its left; what is tied to it directly — companies, and
// the people the Trade Register records at it — to its right; what those reach, one column further. Boxes
// with the name inside, and what the tie is written on each edge.

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
  role: 'роля',
  money: 'плаща',
};

/** What an edge says on itself: the kind of tie — or, for a role tie, the roles. */
export function edgeText(e: CompanyTieEdge): string {
  if (e.kind === 'declared_stake' && e.people?.length === 1) return e.people[0]!.name;
  if (e.kind === 'declared_stake' && e.people && e.people.length > 1)
    return `${e.people.length} общи декларатори`;
  return e.kind === 'role' ? roleEdgeText(e) : TIE_EDGE_LABEL[e.kind];
}

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
  const hop = new Map(nodes.map((n) => [n.id, n.hop] as const));

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
  const drawn = edges.filter((e) => hop.has(e.from) && hop.has(e.to) && e.from !== e.to);
  // Ranked by distance from the centre, not by the tie's own direction: a tie runs from the nearer node to
  // the farther one, so each ring is a column. Money keeps its own direction — it runs into the centre, which
  // is what puts the payers to its left. A tie between two nodes equally far keeps its own direction too.
  const ranked = drawn.map((e) =>
    e.kind !== 'money' && hop.get(e.to)! < hop.get(e.from)!
      ? { v: e.to, w: e.from }
      : { v: e.from, w: e.to },
  );
  const text = drawn.map(edgeText);
  const labelWidth = (i: number) => Math.round(text[i]!.length * EDGE_CHAR_W) + 8;
  drawn.forEach((_, i) => {
    g.setEdge(
      ranked[i]!.v,
      ranked[i]!.w,
      { width: labelWidth(i), height: EDGE_LABEL_H, labelpos: 'c' },
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
      href: nodeHref(n),
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
        text: text[i]!,
        x: round(d.x ?? 0),
        y: round(d.y ?? 0),
        width: labelWidth(i),
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
