// @vitest-environment jsdom
// Deep render tests for NetworkGraph (issue #142 / PR #144). Mounts the ACTUAL component (through a
// real data router, since it calls useFetcher) with jsdom so the useForceGraph effect really runs —
// this exercises the d3-force/d3-drag/d3-zoom lifecycle in-situ, not just the pure helpers it's built
// from. Two things b4a0f321 changed are pinned here:
//  - the Information Card's relations stat guards a null counterpartyTotal (COUNT(*) failure) instead
//    of passing it into count(), matching the "unknown" treatment already used in the caption; and
//  - a node drag is only flagged once the pointer travels past CLICK_DISTANCE, so a sub-pixel tremor
//    under a tap still lets the node's onClick re-centre instead of being swallowed as a drag.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoutesStub } from 'react-router';
import type { NetworkData } from '@sigma/api-contract';
import { NetworkGraph } from './NetworkGraph';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Settles the sim synchronously in the useForceGraph effect (see its `if (reduceMotion)` branch) so
// mounting doesn't leave a live d3-timer running across tests.
function mockMatchMedia(prefersReducedMotion: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)' && prefersReducedMotion,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

// vitest's jsdom environment proxies `window` onto Node's globalThis rather than the real jsdom
// Window instance, so passing it as a synthetic event's `view` fails the constructor's brand check —
// the real instance is stashed at `window.jsdom.window` (see jsdom-environment setup).
function realWindow(): Window {
  return (window as unknown as { jsdom: { window: Window } }).jsdom.window;
}

function network(overrides: Partial<NetworkData> = {}): NetworkData {
  return {
    center: { id: 'eik:1', kind: 'company', label: 'Център ЕООД', slug: 'centar', valueEur: 1000 },
    nodes: [
      {
        id: 'eik:1',
        kind: 'company',
        label: 'Център ЕООД',
        slug: 'centar',
        valueEur: 1000,
        hop: 0,
      },
      {
        id: 'auth:1',
        kind: 'authority',
        label: 'Община Тест',
        slug: 'obshtina',
        valueEur: 500,
        hop: 1,
      },
    ],
    edges: [{ from: 'eik:1', to: 'auth:1', valueEur: 500, contracts: 2 }],
    counterpartyTotal: 1,
    centerOptions: { authorities: [], companies: [] },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mockMatchMedia(true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function renderGraph(data: NetworkData, recentreTo?: NetworkData) {
  const Stub = createRoutesStub([
    { path: '/', Component: () => <NetworkGraph data={data} /> },
    { path: '/network', Component: () => null, loader: () => ({ data: recentreTo ?? data }) },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/']} />);
  });
}

// Finds an SVG node group/link by the label in its <title> — robust against the centre rendering as a
// plain <g> (edges are also bare <g>s with no data-node-id, so "the group without data-node-id" is
// ambiguous; the label in the title is not).
function findNodeByLabel(label: string): Element {
  const title = [...container.querySelectorAll('title')].find((t) =>
    t.textContent?.startsWith(label),
  );
  const el = title?.closest('g, a');
  if (!el) throw new Error(`no rendered node found for label "${label}"`);
  return el;
}

function hoverCenter() {
  const target = findNodeByLabel('Център ЕООД');
  act(() => {
    // Native 'mouseenter' does not bubble, so a delegated React root listener never sees it — React's
    // onMouseEnter plugin is driven off the (bubbling) 'mouseover' event instead.
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
}

describe('NetworkGraph — Information Card relations guard', () => {
  it('shows the explicit "unknown" treatment when counterpartyTotal is null', async () => {
    await renderGraph(network({ counterpartyTotal: null }));
    hoverCenter();
    const dd = container.querySelectorAll('.net-card-stats dd');
    expect(dd[1]?.textContent).toBe('—');
  });

  it('shows the real count when counterpartyTotal is populated', async () => {
    await renderGraph(network({ counterpartyTotal: 7 }));
    hoverCenter();
    const dd = container.querySelectorAll('.net-card-stats dd');
    expect(dd[1]?.textContent).not.toBe('—');
    expect(dd[1]?.textContent).toContain('7');
  });
});

describe('NetworkGraph — drag-vs-click threshold (in-situ, via real d3-drag)', () => {
  function dragNode(dx: number) {
    const node = findNodeByLabel('Община Тест');
    const down = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
      button: 0,
      view: realWindow(),
    });
    act(() => node.dispatchEvent(down));
    const move = new MouseEvent('mousemove', {
      bubbles: true,
      cancelable: true,
      clientX: 100 + dx,
      clientY: 100,
      button: 0,
      view: realWindow(),
    });
    act(() => window.dispatchEvent(move));
    const up = new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      clientX: 100 + dx,
      clientY: 100,
      button: 0,
      view: realWindow(),
    });
    act(() => window.dispatchEvent(up));
    return node;
  }

  // Both cases click the hop-1 node, whose onClick either calls `recentre()` (fetcher.load → the
  // "Зареждане…" indicator appears) or swallows the click when draggedRef was flipped by the drag.
  async function clickAndSettle(node: Element) {
    await act(async () => {
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('a sub-threshold tremor is still a click — the node re-centres (fetcher.load fires)', async () => {
    const recentred = network({
      center: {
        id: 'auth:1',
        kind: 'authority',
        label: 'Община Тест',
        slug: 'obshtina',
        valueEur: 500,
      },
    });
    await renderGraph(network(), recentred);
    const node = dragNode(2); // well under CLICK_DISTANCE (4)
    await clickAndSettle(node);
    // recentre() was reached → the reset button ("Върни се в началото") appears once adopted.
    expect(container.textContent).toContain('Върни се в началото');
  });

  it('travel past the threshold is a real drag — the trailing click is swallowed, no re-centre', async () => {
    const recentred = network({
      center: {
        id: 'auth:1',
        kind: 'authority',
        label: 'Община Тест',
        slug: 'obshtina',
        valueEur: 500,
      },
    });
    await renderGraph(network(), recentred);
    const node = dragNode(20); // well past CLICK_DISTANCE (4)
    await clickAndSettle(node);
    expect(container.textContent).not.toContain('Върни се в началото');
  });
});
