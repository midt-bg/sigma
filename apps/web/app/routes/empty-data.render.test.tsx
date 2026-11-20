// @vitest-environment jsdom
// A database nothing has been loaded into must not read as real, zero-valued data: the home page and the
// unfiltered lists say the data is missing, with the setup steps shown only in a dev build. A list that a
// filter emptied keeps its „no results for these filters“ message.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoutesStub } from 'react-router';

vi.mock('@sigma/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sigma/db')>()),
  getDb: (env: unknown) => env,
}));

import Home from './home';
import Authorities from './authorities';
import { EmptyDataNotice } from '../components/EmptyDataNotice';

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
  vi.unstubAllEnvs();
});

const totals = (contracts: number) => ({
  contracts,
  valueEur: contracts * 1000,
  authorities: contracts ? 1 : 0,
  bidders: contracts ? 1 : 0,
  suspect: 0,
  asOf: contracts ? '2024-05-01' : null,
  refreshedAt: '2024-05-02',
});
const homeData = (contracts: number) => ({
  totals: totals(contracts),
  topCompanies: [],
  topMinistries: [],
  topMunicipalities: [],
  recentSingleOffer: [],
  topSingleOffer: [],
  singleOffer: { valueEur: 0, contracts: 0, baseValueEur: 0, baseContracts: 0 },
  partialStartYear: null,
});
const emptyPage = { items: [], total: 0, nextCursor: null, prevCursor: null };

async function renderHome(contracts: number) {
  const Stub = createRoutesStub([
    { path: '/', Component: Home as never, loader: () => homeData(contracts) },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/']} />);
  });
}
async function renderAuthorities(url: string) {
  const Stub = createRoutesStub([
    {
      path: '/authorities',
      Component: Authorities as never,
      loader: () => ({
        page: emptyPage,
        facets: { types: [], sectors: [] },
        coverage: { coverageEndYear: 2025 },
      }),
    },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={[url]} />);
  });
}

describe('empty database', () => {
  it('replaces the home totals with a notice instead of showing zeros', async () => {
    await renderHome(0);
    expect(container.textContent).toContain('Все още няма заредени данни');
    expect(container.textContent).not.toContain('Накратко');
    expect(container.textContent).not.toContain('Договори и обособени позиции');
  });

  it('keeps the totals when there is data', async () => {
    await renderHome(3);
    expect(container.textContent).not.toContain('Все още няма заредени данни');
    expect(container.textContent).toContain('Договори и обособени позиции');
  });

  it('says the unfiltered list is empty because no data is loaded', async () => {
    await renderAuthorities('/authorities');
    expect(container.textContent).toContain('Все още няма заредени данни');
    expect(container.textContent).not.toContain('Няма резултати за избраните филтри');
  });

  it('keeps the filter message when a filter or a search emptied the list', async () => {
    await renderAuthorities('/authorities?q=x');
    expect(container.textContent).toContain('Няма резултати за избраните филтри');
    expect(container.textContent).not.toContain('Все още няма заредени данни');
  });

  it('treats a sort or page alone as the whole corpus, not a filter', async () => {
    await renderAuthorities('/authorities?sort=count&page=2');
    expect(container.textContent).toContain('Все още няма заредени данни');
  });
});

describe('setup instructions', () => {
  it('are shown to a developer', async () => {
    vi.stubEnv('DEV', true);
    await act(async () => root.render(<EmptyDataNotice />));
    expect(container.textContent).toContain('pnpm run setup');
    expect(container.textContent).toContain('pnpm run import');
  });

  it('are absent from a production build, which tells the public the data is not loaded', async () => {
    vi.stubEnv('DEV', false);
    await act(async () => root.render(<EmptyDataNotice />));
    expect(container.textContent).not.toMatch(/pnpm|setup|import/);
    expect(container.textContent).toContain('Все още няма заредени данни');
  });
});
