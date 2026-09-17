// @vitest-environment jsdom
// /companies/:eik for a company the site knows only from its Trade Register partida: the фирма with its form,
// what the register states, its people, and no procurement figures it does not have.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createRoutesStub } from 'react-router';
import Company, { meta } from './company';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const loaderData = {
  registry: {
    eik: '300000003',
    name: 'САМО РЕГИСТЪР ООД',
    legalForm: 'OOD',
    seat: 'гр. Русе',
    inLiquidation: true,
    asOf: '2026-09-01',
  },
  coverage: { coverageEndYear: 2026 },
  ties: { center: null, nodes: [], edges: [], omitted: 0 },
  people: {
    asOf: '2026-09-01',
    roles: [
      {
        holder: { kind: 'person', name: 'АНГЕЛ АНГЕЛОВ', href: null },
        role: 'manager',
        share: null,
        sharePct: null,
        addedOn: '2015-01-01',
        removedOn: null,
        entryNumber: 'e1',
      },
    ],
  },
  tieLayout: null,
};

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

it('presents the partida alone, says there are no contracts, and lists who is registered', async () => {
  const Stub = createRoutesStub([
    { path: '/companies/:eik', Component: Company, loader: () => loaderData },
    { path: '/companies', Component: () => null },
    { path: '/', Component: () => null },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/companies/300000003']} />);
  });
  expect(container.querySelector('h1')!.textContent).toBe('САМО РЕГИСТЪР ООД');
  expect(container.querySelector('.kicker')!.textContent).toContain('в ликвидация');
  expect(container.textContent).toContain('Няма договори по обществени поръчки в ЦАИС ЕОП');
  expect(container.textContent).toContain('гр. Русе');
  expect(container.querySelector('#people')!.closest('section')!.textContent).toContain(
    'Ангел Ангелов',
  );
  expect(container.querySelector('#network')).toBeNull();
  expect(container.textContent).not.toContain('Общо спечелено');
  const tags = meta({
    data: loaderData,
    params: { eik: '300000003' },
    matches: [],
  } as unknown as Parameters<typeof meta>[0]);
  expect(tags.find((t) => 'title' in t)).toEqual({ title: 'САМО РЕГИСТЪР ООД — СИГМА' });
});
