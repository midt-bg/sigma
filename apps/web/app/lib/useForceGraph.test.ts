import { describe, expect, it } from 'vitest';
import { linkHop } from './useForceGraph';

const node = (hop: number) => ({ id: `n${hop}`, hop, r: 10 });

describe('linkHop', () => {
  it('reads the far (more-peripheral) endpoint when target is the outer node', () => {
    const link = { source: node(1), target: node(2) };
    expect(linkHop(link)).toBe(2);
  });

  it('is direction-independent: same result when source/target are swapped', () => {
    // Edges aren't normalised by direction — a hop-2 edge may point periphery→centre instead of
    // centre→periphery, so `target` can be the LESS peripheral end.
    const link = { source: node(2), target: node(1) };
    expect(linkHop(link)).toBe(2);
  });

  it('handles an edge entirely within one ring', () => {
    const link = { source: node(1), target: node(1) };
    expect(linkHop(link)).toBe(1);
  });
});
