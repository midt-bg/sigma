// @vitest-environment jsdom
// networkRows/networkColumns feed the connections table that sits beside the graph on three pages. The
// table used to render bare labels, so neither a mouse nor a screen reader could navigate from it
// — these pin that both endpoints resolve to their own profile, and that the direction is
// normalised to authority → company regardless of how the edge is oriented in the graph topology.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRoutesStub } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NetworkData } from '@sigma/api-contract';
import { DataTable } from '../components/DataTable';
import { networkColumns, networkRows, nodeHref } from './entity-tables';

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

const auth = {
  id: 'auth:2',
  kind: 'authority' as const,
  label: 'ОБЩИНА ТЕСТОВО',
  slug: '2',
  valueEur: 60,
  hop: 1,
};
const comp = {
  id: 'eik:1',
  kind: 'company' as const,
  label: 'АЛФА СТРОЙ АД',
  slug: '1',
  valueEur: 100,
  hop: 0,
};

function data(edges: NetworkData['edges']): NetworkData {
  return {
    center: { id: comp.id, kind: 'company', label: comp.label, slug: comp.slug, valueEur: 100 },
    nodes: [comp, auth],
    edges,
    centerOptions: { authorities: [], companies: [] },
  };
}

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

describe('nodeHref', () => {
  it('routes by kind', () => {
    expect(nodeHref(auth)).toBe('/authorities/2');
    expect(nodeHref(comp)).toBe('/companies/1');
  });
});

describe('networkRows', () => {
  it('puts the authority first whichever way the edge points', () => {
    const forward = networkRows(
      data([{ from: 'auth:2', to: 'eik:1', valueEur: 60, contracts: 3 }]),
    );
    const reversed = networkRows(
      data([{ from: 'eik:1', to: 'auth:2', valueEur: 60, contracts: 3 }]),
    );
    // The institution awards and pays the company, never the reverse — the row must read that way
    // even when the graph stores the edge the other way round.
    expect([forward[0].from, forward[0].to]).toEqual(['ОБЩИНА ТЕСТОВО', 'АЛФА СТРОЙ АД']);
    expect([reversed[0].from, reversed[0].to]).toEqual(['ОБЩИНА ТЕСТОВО', 'АЛФА СТРОЙ АД']);
    expect([forward[0].fromHref, forward[0].toHref]).toEqual(['/authorities/2', '/companies/1']);
  });

  it('falls back to the raw node id and no href when an endpoint is missing from `nodes`', () => {
    const rows = networkRows(data([{ from: 'auth:2', to: 'eik:gone', valueEur: 1, contracts: 1 }]));
    expect(rows[0].to).toBe('eik:gone');
    expect(rows[0].toHref).toBeNull();
  });

  it('does the same when it is the AUTHORITY side that is missing', () => {
    // With no authority among the two endpoints, `authority` is the unresolved node — the row must
    // degrade on the „От" side exactly as it does on „Към", not silently mislabel the company as the body.
    const rows = networkRows(data([{ from: 'auth:gone', to: 'eik:1', valueEur: 1, contracts: 1 }]));
    expect(rows[0].from).toBe('auth:gone');
    expect(rows[0].fromHref).toBeNull();
    expect(rows[0].toHref).toBe('/companies/1');
  });
});

describe('networkColumns', () => {
  it('renders both endpoints as links to their profiles', () => {
    const rows = networkRows(data([{ from: 'auth:2', to: 'eik:1', valueEur: 60, contracts: 3 }]));
    const hrefs = [
      ...render(
        <DataTable columns={networkColumns} rows={rows} getKey={(r) => `${r.from}-${r.to}`} />,
      ).querySelectorAll('tbody a'),
    ].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/authorities/2', '/companies/1']);
  });

  it('renders an unresolved endpoint as plain text rather than a broken link', () => {
    const rows = [
      ...networkRows(data([{ from: 'auth:2', to: 'eik:gone', valueEur: 1, contracts: 1 }])),
      ...networkRows(data([{ from: 'auth:gone', to: 'eik:1', valueEur: 1, contracts: 1 }])),
    ];
    const table = render(
      <DataTable columns={networkColumns} rows={rows} getKey={(r) => `${r.from}-${r.to}`} />,
    );
    // One link per resolved endpoint: the first row links only its authority, the second only its company.
    expect(table.querySelectorAll('tbody a').length).toBe(2);
    expect(table.textContent).toContain('eik:gone');
    expect(table.textContent).toContain('auth:gone');
  });

  it('formats the money and contract columns', () => {
    const rows = networkRows(data([{ from: 'auth:2', to: 'eik:1', valueEur: 60, contracts: 3 }]));
    const cells = [
      ...render(
        <DataTable columns={networkColumns} rows={rows} getKey={(r) => `${r.from}-${r.to}`} />,
      ).querySelectorAll('tbody td'),
    ].map((td) => td.textContent);
    expect(cells[2]).toContain('60');
    expect(cells[3]).toBe('3');
  });
});
