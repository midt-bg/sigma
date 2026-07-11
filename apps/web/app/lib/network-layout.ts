import type { NetworkEdge, NetworkNode } from '@sigma/api-contract';

// Pure geometry + physics config for the network ego-graph. Extracted so that:
//  • the SSR render (NetworkGraph) and the client force-sim seed share ONE deterministic layout,
//    guaranteeing identical server/first-client markup (no hydration mismatch), and
//  • the radial seed, label-collision guard, force parameters and bounds clamp are unit-testable
//    without a DOM (the d3 sim lifecycle itself lives in the useForceGraph hook).

export interface Geometry {
  W: number;
  H: number;
  CX: number;
  CY: number;
  R1: number; // inner ring radius (hop-1 / direct counterparties)
  R2: number; // outer ring radius (hop-2 / their top other counterparty)
  LABEL_GAP: number; // min vertical px between two labels on the same side
}

const W = 820;
const H = 600;
export const GEOMETRY: Geometry = {
  W,
  H,
  CX: W / 2,
  CY: H / 2,
  R1: 170,
  R2: 300,
  LABEL_GAP: 17,
};

export interface Pt {
  x: number;
  y: number;
}

// Deterministic radial seed: centre in the middle, hop-1 on the inner ring spread evenly, each hop-2
// node near the angle of a hop-1 neighbour it connects to (small alternating jitter avoids exact
// overlap when several share one parent). This is the SSR layout AND the sim's initial positions.
export function seedPositions(
  nodes: NetworkNode[],
  edges: NetworkEdge[],
  geom: Geometry = GEOMETRY,
): Map<string, Pt> {
  const { CX, CY, R1, R2 } = geom;
  const pos = new Map<string, Pt>();
  const angleOf = new Map<string, number>();

  const center = nodes.find((n) => n.hop === 0);
  if (center) pos.set(center.id, { x: CX, y: CY });

  const hop1 = nodes.filter((n) => n.hop === 1);
  const hop2 = nodes.filter((n) => n.hop === 2);

  hop1.forEach((n, i) => {
    const a = (i / Math.max(1, hop1.length)) * Math.PI * 2 - Math.PI / 2;
    angleOf.set(n.id, a);
    pos.set(n.id, { x: CX + Math.cos(a) * R1, y: CY + Math.sin(a) * R1 });
  });

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

  return pos;
}

// Label-collision guard: labels are anchored left/right of their node, so two nodes close in y on the
// same side would overlap. Within each side, sort by y and push each label down until it clears the
// previous one by LABEL_GAP. Deterministic, no measuring — works identically server- and client-side.
export function labelPositions(
  pos: Map<string, Pt>,
  geom: Geometry = GEOMETRY,
): Map<string, number> {
  const { CX, LABEL_GAP } = geom;
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
  return labelY;
}

export interface ForceConfig {
  charge: number; // many-body strength (negative = repulsion)
  linkDistance: (hop: number) => number; // target edge length by the more-peripheral endpoint's hop
  linkStrength: number;
  collidePad: number; // extra px added to a node radius for collision
  radialStrength: number; // pull each node back toward its ring
  velocityDecay: number;
  alphaDecay: number; // > 0 so alpha → alphaMin and the sim STOPS (no infinite RAF)
  alphaMin: number;
}

// Physics tuned to ease out of the flat seed into a genuinely organic shape and then SETTLE STEADILY:
// link distances mirror the seed rings, repulsion separates the spokes, collide stops overlaps. The
// radial pull is kept VERY gentle (0.07) so link+charge can actually rearrange the layout — a strong
// radial just snaps it back to the flat rings and fights the links (the source of the "wobble"). High
// velocityDecay (0.62) critically-damps the motion so it eases in without springy oscillation, and a
// brisk alphaDecay settles it in ~1s, after which the sim STOPS ticking (a stopped sim cannot wobble).
export function forceConfig(geom: Geometry = GEOMETRY): ForceConfig {
  return {
    charge: -360,
    linkDistance: (hop) => (hop >= 2 ? geom.R2 - geom.R1 : geom.R1),
    linkStrength: 0.4,
    collidePad: 7,
    radialStrength: 0.07,
    velocityDecay: 0.62,
    alphaDecay: 0.06,
    alphaMin: 0.005,
  };
}

// The ring radius a node is pulled toward (centre stays at 0 → pinned in place anyway).
export function ringRadius(hop: number, geom: Geometry = GEOMETRY): number {
  if (hop <= 0) return 0;
  return hop === 1 ? geom.R1 : geom.R2;
}

// Keep a point inside the drawing area (used by the sim tick and by drag) so nodes can't fly off the
// canvas or be dragged out of view. `r` is the node radius so the whole glyph stays visible.
export function clampToBounds(p: Pt, r: number, geom: Geometry = GEOMETRY): Pt {
  const pad = r + 2;
  return {
    x: Math.min(geom.W - pad, Math.max(pad, p.x)),
    y: Math.min(geom.H - pad, Math.max(pad, p.y)),
  };
}
