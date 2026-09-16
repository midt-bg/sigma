// @vitest-environment jsdom
// The graph carried every node's profile path in `NetworkNode.slug` and used none of them: nodes were
// inert <rect>/<circle> with a tooltip, so the only route from a name seen here to its page was the
// search box. These tests pin the two halves of the fix — the nodes are links, and the
// <svg> no longer claims role="img", which would hide those links from assistive technology.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRoutesStub } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NetworkData } from '@sigma/api-contract';
import { NetworkGraph } from './NetworkGraph';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const data: NetworkData = {
  center: { id: 'eik:1', kind: 'company', label: 'АЛФА СТРОЙ АД', slug: '1', valueEur: 100 },
  nodes: [
    { id: 'eik:1', kind: 'company', label: 'АЛФА СТРОЙ АД', slug: '1', valueEur: 100, hop: 0 },
    { id: 'auth:2', kind: 'authority', label: 'ОБЩИНА ТЕСТОВО', slug: '2', valueEur: 60, hop: 1 },
    { id: 'eik:3', kind: 'company', label: 'БЕТА ИНЖЕНЕРИНГ АД', slug: '3', valueEur: 40, hop: 2 },
  ],
  edges: [
    { from: 'auth:2', to: 'eik:1', valueEur: 60, contracts: 3 },
    { from: 'auth:2', to: 'eik:3', valueEur: 40, contracts: 2 },
  ],
  centerOptions: { authorities: [], companies: [] },
};

function render(node: React.ReactNode) {
  const Stub = createRoutesStub([
    { path: '/', Component: () => <>{node}</> },
    { path: '/companies/:slug', Component: () => null },
    { path: '/authorities/:slug', Component: () => null },
  ]);
  act(() => {
    root.render(<Stub initialEntries={['/']} />);
  });
  return container;
}

describe('NetworkGraph', () => {
  it('links every node to its own profile, routed by kind', () => {
    const hrefs = [...render(<NetworkGraph data={data} />).querySelectorAll('a.node-link')].map(
      (a) => a.getAttribute('href'),
    );
    expect(hrefs).toEqual(['/companies/1', '/authorities/2', '/companies/3']);
  });

  it('does not present itself as a single image, which would hide the links', () => {
    const svg = render(<NetworkGraph data={data} />).querySelector('svg')!;
    expect(svg.getAttribute('role')).not.toBe('img');
    expect(svg.getAttribute('aria-label')).toContain('АЛФА СТРОЙ АД');
  });

  it('names the destination for a screen reader, kind and weight included', () => {
    const labels = [...render(<NetworkGraph data={data} />).querySelectorAll('a.node-link')].map(
      (a) => a.getAttribute('aria-label'),
    );
    expect(labels[0]).toContain('фирма');
    expect(labels[1]).toContain('институция');
    expect(labels[1]).toContain('ОБЩИНА ТЕСТОВО');
  });

  it('keeps the label inside the link so the text is part of the target', () => {
    // The ring labels are the only readable part of a node at a glance; a link around the marker
    // alone would leave the name unclickable, which is the defect this issue is about one level down.
    const ring = [...render(<NetworkGraph data={data} />).querySelectorAll('a.node-link')].find(
      (a) => a.getAttribute('href') === '/authorities/2',
    )!;
    expect(ring.querySelector('text.node-label')?.textContent).toContain('ОБЩИНА ТЕСТОВО');
  });

  it('places, links and truncates an outer-ring node reached through either edge direction', () => {
    // hop-2 nodes are positioned near the hop-1 neighbour they connect to; the parent is found from
    // whichever END of the edge is already placed. Both orientations must resolve, and a long label is
    // truncated so it cannot run over its neighbours.
    const long = 'ОБЕДИНЕНИЕ С МНОГО ДЪЛГО ИМЕ ЗА ЕДИН ВЪЗЕЛ';
    const c = render(
      <NetworkGraph
        data={{
          ...data,
          nodes: [...data.nodes, { ...data.nodes[2], id: 'eik:4', slug: '4', label: long, hop: 2 }],
          edges: [
            ...data.edges,
            // reversed orientation: the placed node is the edge's `to`, not its `from`
            { from: 'eik:4', to: 'auth:2', valueEur: 10, contracts: 1 },
          ],
        }}
      />,
    );
    expect(c.querySelector('a[href="/companies/4"]')).not.toBeNull();
    const label = [...c.querySelectorAll('text.node-label')].find((t) =>
      t.textContent?.startsWith('ОБЕДИНЕНИЕ'),
    )!;
    expect(label.textContent).toContain('…');
    expect(label.textContent!.length).toBeLessThan(long.length);
  });

  it('places an outer node with no edge back to the placed ring, and labels both sides of the centre', () => {
    // An orphan hop-2 node (no edge touching a positioned node) falls back to an even spread instead of
    // throwing; and with several ring nodes some sit left of the centre, where the label anchors to the
    // other side.
    const c = render(
      <NetworkGraph
        data={{
          ...data,
          nodes: [
            ...data.nodes,
            { ...data.nodes[1], id: 'auth:5', slug: '5', label: 'ОБЩИНА ВАРНА', hop: 1 },
            { ...data.nodes[2], id: 'eik:6', slug: '6', label: 'ОРФАН ЕООД', hop: 2 },
          ],
        }}
      />,
    );
    expect(c.querySelector('a[href="/companies/6"]')).not.toBeNull();
    const anchors = [...c.querySelectorAll('text.node-label')].map((t) =>
      t.getAttribute('text-anchor'),
    );
    expect(anchors).toContain('start');
    expect(anchors).toContain('end');
  });

  it('skips an edge or node the layout could not place instead of drawing it at 0,0', () => {
    const c = render(
      <NetworkGraph
        data={{
          ...data,
          // `eik:missing` is referenced by an edge but absent from `nodes`, so it never gets a position.
          edges: [...data.edges, { from: 'eik:missing', to: 'eik:1', valueEur: 5, contracts: 1 }],
        }}
      />,
    );
    expect(c.querySelectorAll('line.edge').length).toBe(2); // the third is dropped, not drawn to origin
    expect(c.querySelector('a[href="/companies/missing"]')).toBeNull();
  });

  it('renders nothing without a centre or with a single node', () => {
    expect(
      render(<NetworkGraph data={{ ...data, center: null }} />).querySelector('svg'),
    ).toBeNull();
    expect(
      render(<NetworkGraph data={{ ...data, nodes: [data.nodes[0]] }} />).querySelector('svg'),
    ).toBeNull();
  });
});

describe('NetworkGraph — nodes beyond the drawn rings', () => {
  it('leaves out a node it has no ring for, rather than drawing it at the origin', () => {
    // Only the centre and two rings are laid out; a node reported any further out has no position.
    const c = render(
      <NetworkGraph
        data={{
          ...data,
          nodes: [
            ...data.nodes,
            {
              id: 'eik:9',
              kind: 'company',
              label: 'ДАЛЕЧНА ФИРМА ООД',
              slug: '9',
              valueEur: 5,
              hop: 3,
            },
          ],
          edges: [...data.edges, { from: 'eik:3', to: 'eik:9', valueEur: 5, contracts: 1 }],
        }}
      />,
    );
    expect([...c.querySelectorAll('a.node-link')].map((a) => a.getAttribute('href'))).toEqual([
      '/companies/1',
      '/authorities/2',
      '/companies/3',
    ]);
    expect(c.querySelectorAll('line.edge')).toHaveLength(2);
    expect(c.textContent).not.toContain('ДАЛЕЧНА');
  });
});
