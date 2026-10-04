// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRoutesStub } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AuthorityDetail,
  CompanyTieNetwork,
  CompetitionTotals,
  ProcedureCompetition,
  TrendData,
} from '@sigma/api-contract';
import Authority from './authority';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const authority: AuthorityDetail = {
  slug: '000000000',
  name: 'Тестова институция',
  eik: '000000000',
  typeGroup: 'агенция',
  typeLabel: 'Агенция',
  settlement: 'гр. Тестово',
  region: 'Тестова област',
  spentEur: 1_000_000,
  contracts: 20,
  suppliers: 6,
  avgEur: 50_000,
  euSharePct: 0.1,
  avgBids: 2.5,
  periodFirst: '2021-01-01',
  periodLast: '2025-06-30',
  suspect: 0,
  frameworkAgreements: 0,
  frameworkCeilingEur: 0,
  topContractors: [],
  moreContractors: 0,
  sectors: [],
  sectorsOther: null,
  // 20 contracts: 11 open, 3 direct, 1 with an invitation, 5 with no recorded procedure.
  procedureMix: [
    {
      key: 'open',
      label: 'Открита',
      color: '#334455',
      competitive: true,
      contracts: 11,
      valueEur: 800_000,
      sharePct: 0.8,
      contractSharePct: 0.55,
    },
    {
      key: 'negotiated_invited',
      label: 'Договаряне с покана',
      color: '#556677',
      competitive: null,
      contracts: 1,
      valueEur: 20_000,
      sharePct: 0.02,
      contractSharePct: 0.05,
    },
    {
      key: 'direct',
      label: 'Пряко / без обявление',
      color: '#aa0000',
      competitive: false,
      contracts: 3,
      valueEur: 80_000,
      sharePct: 0.08,
      contractSharePct: 0.15,
    },
    {
      key: 'unknown',
      label: 'Неизвестна',
      color: '#778899',
      competitive: null,
      contracts: 5,
      valueEur: 100_000,
      sharePct: 0.1,
      contractSharePct: 0.25,
    },
  ],
  recentContracts: [],
  topContracts: [],
};

const trend: TrendData = {
  granularity: 'year',
  points: [],
  years: [],
  sectors: [],
  totalValueEur: 0,
  coverage: { dated: 0, total: 0, pct: 0 },
  scope: { sector: null, funding: 'all', granularity: 'year' },
};

const ties: CompanyTieNetwork = { center: null, nodes: [], edges: [], omitted: 0 };

const competition: CompetitionTotals = {
  contracts: 10,
  singleOffer: 2,
  singleOfferShare: 0.2,
  valueEur: 500_000,
  singleOfferValueEur: 50_000,
  singleOfferValueShare: 0.1,
};

// The direct-award share counts the classified contracts only: 3 of the 14 open or direct ones.
const procedure: ProcedureCompetition = {
  classifiedContracts: 14,
  nonCompetitiveContracts: 3,
  nonCompetitiveShare: 3 / 14,
  nonCompetitiveValueEur: 80_000,
  totalContracts: 20,
};

const baseData = {
  authority,
  coverage: {
    asOf: '2025-06-30',
    refreshedAt: '2025-07-01T00:00:00Z',
    coverageEndYear: 2025,
    partialStartYear: null,
  },
  trend,
  ties,
  tieLayout: null,
  competition,
  procedure,
  conflicts: { companies: 0, ownCompanies: 0 },
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

async function mount(loaderData: unknown) {
  const Stub = createRoutesStub([
    { path: '/authorities/:eik', Component: Authority, loader: () => loaderData },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/authorities/000000000']} />);
  });
}

const section = (id: string) => container.querySelector(`#${id}`)?.closest('section') ?? null;

describe('/authorities/:eik — the direct-award share', () => {
  it('shows one direct-award percentage, with the groups its base leaves out named beside it', async () => {
    await mount(baseData);

    const gauge = section('single-offer')!.textContent;
    expect(gauge).toContain('21,4');
    expect(gauge).toContain(
      '3 от 14 класифицирани договора (без „Договаряне с покана“, „Друго“ и „Неизвестна“)',
    );

    // The procedure bar counts contracts — all 20, on the same set — and gives no second percentage.
    const how = section('how')!.textContent;
    expect(how).toContain('всички 20 договора на институцията');
    expect(how).toContain('Пряко / без обявление · 3 договора');
    expect(how).toContain('Неизвестна · 5 договора');
    expect(how).not.toMatch(/\d %|\d%/);
  });
});
