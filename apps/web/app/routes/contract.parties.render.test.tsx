// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRoutesStub } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContractDetail, ContractParty } from '@sigma/api-contract';
import Contract from './contract';

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

const party = (over: Partial<ContractParty>): ContractParty => ({
  slug: '000000000',
  name: 'Община Тест',
  displayName: 'Община Тест',
  orderingUnit: null,
  typeLabel: null,
  settlement: null,
  eik: '000000000',
  sector: null,
  totalContracts: 0,
  totalEur: 0,
  ...over,
});

// Invented parties. The authority has 20 summed contracts; its list also shows 2 framework agreements and
// a contract without a value — 23 rows, so the link must not say „Всички 20".
const contract: ContractDetail = {
  id: 'e:TEST-1:1:1:eik:111111111:1',
  subject: 'Тестова доставка',
  unp: '00000-2025-0001',
  contractNumber: '1',
  documentNumber: null,
  eopTenderId: null,
  lotLabel: null,
  signedAt: '2025-03-01',
  publishedAt: '2025-03-05',
  dateSuspect: false,
  startDate: null,
  endDate: null,
  contractKind: null,
  cpvCode: null,
  cpvDescription: null,
  sector: null,
  procedureLabel: 'Открита процедура',
  bidsReceived: 2,
  bidsRejected: null,
  bidsSme: null,
  bidsNonEea: null,
  euFunded: false,
  euProgramme: null,
  durationDays: null,
  value: {
    estimatedEur: 10_000,
    procedureEstimatedEur: 10_000,
    signingEur: 9_000,
    currentEur: 9_000,
    deltaPct: null,
    suspect: false,
    flag: 'ok',
    currentValueDoubled: false,
  },
  frameworkAwards: null,
  frameworkAgreement: false,
  authority: party({ totalContracts: 20, totalEur: 1_000_000 }),
  bidder: party({
    slug: '111111111',
    name: 'ТЕСТ ГРУП ЕООД',
    displayName: 'ТЕСТ ГРУП ЕООД',
    eik: '111111111',
    kind: 'company',
    totalContracts: 1,
    totalEur: 9_000,
  }),
  lots: null,
  subcontractor: null,
  cohort: null,
  amendments: [],
};

async function mount(c: ContractDetail) {
  const Stub = createRoutesStub([
    { path: '/contracts/:id', Component: Contract, loader: () => ({ contract: c }) },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/contracts/test']} />);
  });
}

const link = (href: string) =>
  [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === href) ?? null;

describe('/contracts/:id — the links to each party’s contracts', () => {
  it('names the list the link opens and gives the summed count as the summed count', async () => {
    await mount(contract);

    const toAuthority = link('/contracts?authority=000000000')!;
    expect(toAuthority.textContent).toBe('→ Всички договори на институцията');
    const authorityItem = toAuthority.closest('li')!.textContent!.replace(/\s+/g, ' ');
    expect(authorityItem).toContain('(20 договора със стойност, 1 млн. €)');
    expect(authorityItem).not.toMatch(/Всички 20/);

    const toBidder = link('/contracts?bidder=111111111')!;
    expect(toBidder.textContent).toBe('→ Всички договори на изпълнителя');
    expect(toBidder.closest('li')!.textContent!.replace(/\s+/g, ' ')).toContain(
      '(1 договор със стойност, 9 хил. €)',
    );
  });

  it('shows no summed count for a party whose contracts are all without a value', async () => {
    // A party to framework agreements only: no summed contract, the list still has its agreements.
    await mount({ ...contract, bidder: { ...contract.bidder, totalContracts: 0, totalEur: 0 } });

    const item = link('/contracts?bidder=111111111')!.closest('li')!.textContent!;
    expect(item.trim()).toBe('→ Всички договори на изпълнителя');
  });
});
