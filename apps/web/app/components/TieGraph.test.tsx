// @vitest-environment jsdom
// The company tie graph, drawn from its server-side layout. Two things are load-bearing and both are
// pinned here (the layout itself is pinned in lib/tie-layout.server.test.ts):
//
//  1. The EDGE carries the meaning. Unlike the money graph, where every edge means the same thing, here a
//     solid line and a dotted one are different claims — so each kind must reach the DOM as its own class
//     and its own written label, and a declared-stake tie must not be sized by money it does not have.
//  2. No person is ever a node and no personal name appears. The shared-official tie is drawn between the
//     two COMPANIES and links to /conflicts, the noindex surface where that name is already published.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRoutesStub } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CompanyTieNetwork } from '@sigma/api-contract';
import { layoutTies } from '../lib/tie-layout.server';
import { TieGraph, tieDescription } from './TieGraph';

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

const node = (over: Partial<CompanyTieNetwork['nodes'][number]> = {}) => ({
  id: 'eik:1',
  kind: 'company' as const,
  label: 'АЛФА СТРОЙ АД',
  slug: '1',
  valueEur: 100,
  hop: 0,
  conflictsHref: null,
  ...over,
});

const base: CompanyTieNetwork = {
  center: node(),
  nodes: [node(), node({ id: 'eik:2', slug: '2', label: 'БЕТА ИНЖЕНЕРИНГ АД', hop: 1 })],
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

function render(data: CompanyTieNetwork) {
  const layout = layoutTies(data);
  const Stub = createRoutesStub([
    { path: '/', Component: () => <TieGraph layout={layout} /> },
    { path: '/companies/:slug', Component: () => null },
    { path: '/authorities/:slug', Component: () => null },
  ]);
  act(() => {
    root.render(<Stub initialEntries={['/']} />);
  });
  return container;
}

describe('TieGraph', () => {
  it('gives each tie kind its own class and its own written label', () => {
    const c = render({
      ...base,
      nodes: [...base.nodes, node({ id: 'eik:3', slug: '3', label: 'ГАМА ООД', hop: 1 })],
      edges: [
        ...base.edges,
        {
          from: 'eik:1',
          to: 'eik:3',
          kind: 'subcontract',
          directed: true,
          weightEur: 500,
          occurrences: 1,
          href: null,
        },
      ],
    });
    expect(c.querySelector('.tie-edge.tie-consortium')).not.toBeNull();
    expect(c.querySelector('.tie-edge.tie-subcontract')).not.toBeNull();
    const labels = [...c.querySelectorAll('.tie-edge-label')].map((t) => t.textContent);
    expect(labels).toEqual(['обединение', 'подизпълнител']);
  });

  it('marks a directed tie with an arrow and leaves a symmetric one unmarked', () => {
    const c = render({
      ...base,
      edges: [{ ...base.edges[0]!, kind: 'subcontract', directed: true }],
    });
    expect(c.querySelector('.tie-subcontract')?.getAttribute('marker-end')).toContain('tie-arrow');
    const sym = render(base);
    expect(sym.querySelector('.tie-consortium')?.getAttribute('marker-end')).toBeNull();
  });

  it('does not draw a declared-stake tie thinner just because it carries no money', () => {
    // Sized by money it would be the faintest line on the page — the one edge that rests on a declared
    // interest would read as the weakest, which is the opposite of what it is.
    const c = render({
      ...base,
      edges: [
        { ...base.edges[0]!, weightEur: 1_000_000 },
        {
          from: 'eik:1',
          to: 'eik:2',
          kind: 'declared_stake',
          directed: false,
          weightEur: 0,
          occurrences: 1,
          href: '/conflicts/company/1',
        },
      ],
    });
    const width = (sel: string) =>
      Number.parseFloat((c.querySelector(sel) as SVGElement).style.strokeWidth);
    expect(width('.tie-declared_stake')).toBeGreaterThan(1);
  });

  it('never renders a person node, only companies and institutions', () => {
    const c = render({
      ...base,
      nodes: [
        ...base.nodes,
        node({ id: 'auth:9', kind: 'authority', slug: '9', label: 'ОБЩИНА ТЕСТОВО', hop: 1 }),
      ],
      edges: [
        ...base.edges,
        {
          from: 'auth:9',
          to: 'eik:1',
          kind: 'money',
          directed: true,
          weightEur: 700,
          occurrences: 0,
          href: null,
        },
      ],
    });
    const hrefs = [...c.querySelectorAll('a.tie-node-link')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/companies/1', '/companies/2', '/authorities/9']);
  });

  it('is a group of links, not one image — role="img" would hide the nodes', () => {
    const svg = render(base).querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('group');
    expect(svg.getAttribute('aria-label')).toContain('АЛФА СТРОЙ АД');
  });

  it('names every box inside it, the centre included', () => {
    const labels = [...render(base).querySelectorAll('text.tie-node-label')].map(
      (t) => t.textContent,
    );
    expect(labels).toEqual(['АЛФА СТРОЙ АД', 'БЕТА ИНЖЕНЕРИНГ АД']);
  });

  it('lists only the tie kinds actually drawn', () => {
    const legend = [...render(base).querySelectorAll('.tie-legend li')].map((l) =>
      l.textContent?.trim(),
    );
    expect(legend).toEqual(['общо обединение']);
  });

  it('gives the full name to a reader even where the box cuts it', () => {
    const long = 'ОБЕДИНЕНИЕ С МНОГО ДЪЛГО ИМЕ, КОЕТО НЯМА ДА СЕ ПОБЕРЕ В НИТО ЕДНА КУТИЯ';
    const c = render({
      ...base,
      nodes: [node(), node({ id: 'eik:2', slug: '2', label: long, hop: 1 })],
    });
    const link = [...c.querySelectorAll('a.tie-node-link')][1]!;
    expect(link.querySelector('text')!.textContent).toContain('…');
    expect(link.getAttribute('aria-label')).toContain(long);
  });

  it('renders nothing without a centre or with a lone node', () => {
    expect(render({ ...base, center: null }).querySelector('svg')).toBeNull();
    expect(render({ ...base, nodes: [node()] }).querySelector('svg')).toBeNull();
  });
});

describe('tieDescription', () => {
  const e = (over: Partial<CompanyTieNetwork['edges'][number]>) => ({ ...base.edges[0]!, ...over });

  it('says how often a tie recurs, and drops the count when it happened once', () => {
    expect(tieDescription(e({ occurrences: 3 }))).toContain('3');
    expect(tieDescription(e({ occurrences: 1 }))).not.toContain('1 пъти');
  });

  it('describes a stake tie without a sum, and by how many officials back it', () => {
    expect(tieDescription(e({ kind: 'declared_stake', weightEur: 0, occurrences: 1 }))).toBe(
      'общо свързано лице',
    );
    expect(tieDescription(e({ kind: 'declared_stake', weightEur: 0, occurrences: 2 }))).toContain(
      'лица',
    );
  });

  it('describes the money layer as a payment', () => {
    expect(tieDescription(e({ kind: 'money', weightEur: 1000 }))).toContain('плаща');
  });
});
