import { describe, expect, it } from 'vitest';
import type { NetworkEdge, NetworkNode } from '@sigma/api-contract';
import {
  clampToBounds,
  forceConfig,
  GEOMETRY,
  labelPositions,
  ringRadius,
  seedPositions,
  type Pt,
} from './network-layout';

// Pure layout/physics helpers shared by the SSR render and the client force-sim seed (issue #142).
// These pin the determinism the no-hydration-mismatch guarantee relies on: the same nodes/edges must
// always produce the same seed positions, server- and client-side.

const node = (id: string, hop: number, extra: Partial<NetworkNode> = {}): NetworkNode => ({
  id,
  kind: 'company',
  label: id,
  slug: id,
  valueEur: 100,
  hop,
  ...extra,
});

const sample = (): { nodes: NetworkNode[]; edges: NetworkEdge[] } => {
  const nodes: NetworkNode[] = [
    node('C', 0, { kind: 'authority' }),
    node('a1', 1, { kind: 'company' }),
    node('a2', 1, { kind: 'company' }),
    node('a3', 1, { kind: 'authority' }),
    node('b1', 2),
    node('b2', 2),
  ];
  const edges: NetworkEdge[] = [
    { from: 'C', to: 'a1', valueEur: 10, contracts: 1 },
    { from: 'C', to: 'a2', valueEur: 20, contracts: 2 },
    { from: 'C', to: 'a3', valueEur: 30, contracts: 3 },
    { from: 'a1', to: 'b1', valueEur: 5, contracts: 1 },
    { from: 'a2', to: 'b2', valueEur: 6, contracts: 1 },
  ];
  return { nodes, edges };
};

describe('seedPositions', () => {
  it('pins the centre at the geometric centre', () => {
    const { nodes, edges } = sample();
    const pos = seedPositions(nodes, edges);
    expect(pos.get('C')).toEqual({ x: GEOMETRY.CX, y: GEOMETRY.CY });
  });

  it('places hop-1 nodes on the inner ring (R1) and hop-2 on the outer ring (R2)', () => {
    const { nodes, edges } = sample();
    const pos = seedPositions(nodes, edges);
    const dist = (p: Pt) => Math.hypot(p.x - GEOMETRY.CX, p.y - GEOMETRY.CY);
    for (const id of ['a1', 'a2', 'a3']) {
      expect(dist(pos.get(id)!)).toBeCloseTo(GEOMETRY.R1, 5);
    }
    // hop-2 nodes sit ~R2 from the centre (jitter is angular, so radius is exact).
    for (const id of ['b1', 'b2']) {
      expect(dist(pos.get(id)!)).toBeCloseTo(GEOMETRY.R2, 5);
    }
  });

  it('is deterministic — identical input gives byte-identical positions (SSR/client match)', () => {
    const { nodes, edges } = sample();
    expect([...seedPositions(nodes, edges).entries()]).toEqual([
      ...seedPositions(nodes, edges).entries(),
    ]);
  });

  it('does not mutate the input nodes/edges (d3 gets copies, not these)', () => {
    const { nodes, edges } = sample();
    const snapshot = JSON.stringify({ nodes, edges });
    seedPositions(nodes, edges);
    expect(JSON.stringify({ nodes, edges })).toBe(snapshot);
  });

  it('places each hop-2 node near the angle of the hop-1 parent it links to', () => {
    const { nodes, edges } = sample();
    const pos = seedPositions(nodes, edges);
    const angle = (p: Pt) => Math.atan2(p.y - GEOMETRY.CY, p.x - GEOMETRY.CX);
    // b1 links to a1 → their angles should be within the jitter band (|Δ| ≤ ~0.14).
    expect(Math.abs(angle(pos.get('b1')!) - angle(pos.get('a1')!))).toBeLessThan(0.2);
  });
});

describe('labelPositions', () => {
  it('separates same-side labels by at least LABEL_GAP', () => {
    // Two nodes on the right side, 2px apart in y → must be pushed to LABEL_GAP apart.
    const pos = new Map<string, Pt>([
      ['n1', { x: GEOMETRY.CX + 50, y: 100 }],
      ['n2', { x: GEOMETRY.CX + 50, y: 102 }],
    ]);
    const labelY = labelPositions(pos);
    expect(labelY.get('n2')! - labelY.get('n1')!).toBeGreaterThanOrEqual(GEOMETRY.LABEL_GAP);
  });

  it('treats left and right sides independently', () => {
    const pos = new Map<string, Pt>([
      ['L', { x: GEOMETRY.CX - 50, y: 100 }],
      ['R', { x: GEOMETRY.CX + 50, y: 101 }],
    ]);
    const labelY = labelPositions(pos);
    // Opposite sides do not collide, so neither is pushed off its node's y.
    expect(labelY.get('L')).toBe(100);
    expect(labelY.get('R')).toBe(101);
  });
});

describe('forceConfig', () => {
  it('repels (negative charge) and settles (bounded alpha decay > 0, alphaMin > 0)', () => {
    const cfg = forceConfig();
    expect(cfg.charge).toBeLessThan(0);
    expect(cfg.alphaDecay).toBeGreaterThan(0);
    expect(cfg.alphaMin).toBeGreaterThan(0);
  });

  it('uses the centre→inner-ring distance for hop-1 and the inter-ring gap for hop-2', () => {
    const cfg = forceConfig();
    // hop-1 edges span centre→inner ring (R1); hop-2 edges span inner→outer ring (R2−R1).
    expect(cfg.linkDistance(1)).toBe(GEOMETRY.R1);
    expect(cfg.linkDistance(2)).toBe(GEOMETRY.R2 - GEOMETRY.R1);
    // Both are positive so the link force has a real rest length.
    expect(cfg.linkDistance(2)).toBeGreaterThan(0);
  });
});

describe('ringRadius', () => {
  it('is 0 for the centre and R1/R2 for hop 1/2', () => {
    expect(ringRadius(0)).toBe(0);
    expect(ringRadius(1)).toBe(GEOMETRY.R1);
    expect(ringRadius(2)).toBe(GEOMETRY.R2);
  });
});

describe('clampToBounds', () => {
  it('keeps the whole glyph inside the canvas', () => {
    const r = 20;
    expect(clampToBounds({ x: -100, y: -100 }, r)).toEqual({ x: r + 2, y: r + 2 });
    expect(clampToBounds({ x: 10_000, y: 10_000 }, r)).toEqual({
      x: GEOMETRY.W - (r + 2),
      y: GEOMETRY.H - (r + 2),
    });
  });

  it('leaves an in-bounds point untouched', () => {
    expect(clampToBounds({ x: 400, y: 300 }, 10)).toEqual({ x: 400, y: 300 });
  });
});
