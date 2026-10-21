// @vitest-environment jsdom
// /competition through its real loader (data layer stubbed): the tables, their empty states and the
// unknown-filter notice.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoutesStub } from 'react-router';
import type { CompetitionData } from '@sigma/api-contract';

const { getCompetition } = vi.hoisted(() => ({ getCompetition: vi.fn() }));
vi.mock('@sigma/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sigma/db')>()),
  getCompetition,
  getDb: (env: unknown) => env,
}));
vi.mock('../lib/coverage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/coverage')>()),
  getCoverageMeta: async () => ({
    asOf: '2025-06-30',
    refreshedAt: null,
    coverageEndYear: 2025,
    partialStartYear: null,
  }),
}));

import Competition, { loader } from './competition';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  getCompetition.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const authority = { slug: '000000001', name: 'Община Тест', typeLabel: 'Община' };
const full: CompetitionData = {
  totals: {
    contracts: 100,
    singleOffer: 40,
    singleOfferShare: 0.4,
    valueEur: 1_000_000,
    singleOfferValueEur: 300_000,
    singleOfferValueShare: 0.3,
  },
  procedure: {
    classifiedContracts: 80,
    nonCompetitiveContracts: 20,
    nonCompetitiveShare: 0.25,
    nonCompetitiveValueEur: 100_000,
    totalContracts: 100,
  },
  bySingleOffer: [
    { ...authority, contracts: 30, singleOffer: 20, singleOfferShare: 0.66, valueEur: 500_000 },
    {
      slug: '000000002',
      name: 'Община Проба',
      typeLabel: null,
      contracts: 10,
      singleOffer: 1,
      singleOfferShare: 0.1,
      valueEur: 1000,
    },
  ],
  byDirectAward: [
    { ...authority, classified: 30, nonCompetitive: 25, nonCompetitiveShare: 0.83, valueEur: 9 },
    {
      slug: '000000002',
      name: 'Община Проба',
      typeLabel: null,
      classified: 10,
      nonCompetitive: 1,
      nonCompetitiveShare: 0.1,
      valueEur: 9,
    },
  ],
  byConcentration: [
    { ...authority, suppliers: 2, contracts: 30, valueEur: 500_000, hhi: 0.6 },
    {
      slug: '000000002',
      name: 'Община Проба',
      typeLabel: null,
      suppliers: 9,
      contracts: 10,
      valueEur: 1000,
      hhi: 0.1,
    },
  ],
  topPairs: [
    {
      rank: 1,
      authoritySlug: '000000001',
      authorityName: 'Община Тест',
      bidderSlug: '111111111',
      bidderName: 'ТЕСТ ГРУП ЕООД',
      bidderDisplayName: 'ТЕСТ ГРУП ЕООД',
      bidderKind: 'company',
      contracts: 12,
      wonEur: 200_000,
    },
  ],
  sectors: [{ code: '45', label: 'Строителство', short: 'Строителство' }],
  scope: { sector: null, year: null, funding: 'all', top: 20, minContracts: 10 },
};
const empty: CompetitionData = {
  ...full,
  bySingleOffer: [],
  byDirectAward: [],
  byConcentration: [],
  topPairs: [],
};

async function render(url: string) {
  const Stub = createRoutesStub([
    {
      path: '/competition',
      Component: Competition as never,
      loader: (args) => loader({ ...args, context: { cloudflare: { env: {} } } } as never),
    },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={[url]} />);
  });
}

const text = () => container.textContent ?? '';

describe('/competition', () => {
  it('renders every leaderboard with links to the authorities and the company', async () => {
    getCompetition.mockResolvedValue(full);
    await render('/competition?sector=45&year=2024&funding=eu&top=50');
    expect(getCompetition).toHaveBeenCalledWith(
      {},
      { sector: '45', year: '2024', funding: 'eu', top: 50 },
    );
    expect(container.querySelectorAll('table')).toHaveLength(4);
    expect(container.querySelector('a[href="/companies/111111111"]')?.textContent).toBe(
      'ТЕСТ ГРУП ЕООД',
    );
    expect(container.querySelectorAll('a[href="/authorities/000000001"]').length).toBe(4);
    expect(text()).toContain('40%');
    expect(text()).not.toContain('Непознат филтър');
  });

  it('says so when a table has no rows, and drops unknown filters with a notice', async () => {
    getCompetition.mockResolvedValue(empty);
    await render('/competition?sector=zz&year=1900');
    expect(getCompetition).toHaveBeenCalledWith(
      {},
      { sector: null, year: null, funding: 'all', top: 20 },
    );
    expect(container.querySelectorAll('table')).toHaveLength(0);
    expect(text().match(/Няма достатъчно данни/g)).toHaveLength(4);
    expect(text()).toContain('Избраният сектор не съществува.');
    expect(text()).toContain('Избраната година е извън обхвата.');
  });
});
