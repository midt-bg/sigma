// The tie layout's contract with its engine. dagre is CommonJS: under Node its exports sit on `default`, but
// after the bundler's interop they sit on the namespace itself — the layout must run either way. And the
// engine's types leave a label's position and the graph's size optional: whatever it does not set is drawn at
// 0, never as NaN in the SVG. The real engine always sets them, so a stand-in engine pins that fallback.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompanyTieNetwork } from '@sigma/api-contract';

type Engine = typeof import('@dagrejs/dagre');
const engine = vi.hoisted(() => ({ layout: null as null | ((g: unknown) => void) }));
vi.mock('@dagrejs/dagre', async (importOriginal) => {
  const real = (await importOriginal<{ default: Engine }>()).default;
  // The bundled shape: no `default`, the exports on the namespace itself.
  return {
    default: undefined,
    graphlib: real.graphlib,
    layout: (g: Parameters<Engine['layout']>[0]) =>
      engine.layout ? engine.layout(g) : real.layout(g),
  };
});

import { layoutTies } from './tie-layout.server';

const node = (id: string, hop: number) => ({
  id,
  kind: 'company' as const,
  label: `ДРУЖЕСТВО ${id}`,
  slug: id.slice(4),
  valueEur: 100,
  hop,
  conflictsHref: null,
});
const net: CompanyTieNetwork = {
  center: node('eik:1', 0),
  nodes: [node('eik:1', 0), node('eik:2', 1)],
  edges: [
    {
      from: 'eik:1',
      to: 'eik:2',
      kind: 'consortium',
      directed: false,
      weightEur: 900,
      occurrences: 3,
      href: null,
    },
  ],
  omitted: 0,
};

afterEach(() => {
  engine.layout = null;
});

describe('layoutTies — the engine as the bundle exposes it', () => {
  it('lays the graph out with the namespace’s own exports when there is no default', () => {
    const l = layoutTies(net)!;
    const [centre, other] = l.nodes;
    expect(centre!.x).toBeLessThan(other!.x);
    expect(l.width).toBeGreaterThan(0);
    expect(l.height).toBeGreaterThan(0);
    expect(l.edges[0]!.label.text).toBe('съвместно изпълнение');
  });

  it('draws what the engine leaves unplaced at 0, never NaN', () => {
    // Places the boxes and routes the edge, but leaves the label and the graph's size unset.
    engine.layout = (g) => {
      const graph = g as {
        nodes(): string[];
        node(id: string): object;
        edges(): object[];
        edge(e: object): object;
      };
      graph.nodes().forEach((id, i) => Object.assign(graph.node(id), { x: 100 * i + 60, y: 30 }));
      for (const e of graph.edges())
        Object.assign(graph.edge(e), {
          points: [
            { x: 120, y: 30 },
            { x: 140, y: 30 },
          ],
        });
    };
    const l = layoutTies(net)!;
    expect(l.nodes.map((n) => [n.x, n.y])).toEqual([
      [60, 30],
      [160, 30],
    ]);
    expect(l.edges[0]!.label).toMatchObject({ x: 0, y: 0 });
    expect(l.width).toBe(0);
    expect(l.height).toBe(0);
  });
});
