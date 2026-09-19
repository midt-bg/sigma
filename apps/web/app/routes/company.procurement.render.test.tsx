// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRoutesStub } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CompanyDetail,
  CompanyTieNetwork,
  ConflictLink,
  ContractListItem,
  TrendData,
} from '@sigma/api-contract';
import { layoutTies } from '../lib/tie-layout.server';
import Company, { meta } from './company';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const contract: ContractListItem = {
  id: 'contract-test-1',
  subject: 'Доставка за тестова лаборатория',
  unp: 'TEST-2026-1',
  sectorCode: '38',
  euFunded: true,
  isConsortium: true,
  authoritySlug: 'test-authority',
  authorityName: 'Тестова институция',
  bidderSlug: 'test-group',
  bidderName: '„ТЕСТ ГРУП“ ДЗЗД',
  bidderDisplayName: '„Тест Груп“ и партньори',
  bidderKind: 'consortium',
  procedureLabel: 'Открита процедура',
  signedAt: '2025-04-03',
  bidsReceived: 3,
  valueEur: 120_000,
  valueUnverified: false,
};

const richCompany: CompanyDetail = {
  slug: 'test-group',
  name: '„ТЕСТ ГРУП“ ДЗЗД',
  displayName: '„Тест Груп“ и партньори',
  kind: 'consortium',
  isConsortium: true,
  eik: '123456789',
  hasEik: true,
  ownershipKind: 'mixed',
  settlement: 'гр. Тестово',
  region: 'Тестова област',
  legalForm: null,
  wonEur: 320_000,
  contracts: 8,
  authorities: 3,
  sector: { code: '38', label: 'Тестови услуги', short: 'Услуги' },
  sectorSharePct: 0.75,
  euSharePct: 0.25,
  avgBids: 2.5,
  periodFirst: '2021-01-01',
  periodLast: '2025-04-03',
  suspect: 2,
  topAuthorities: [
    {
      slug: 'test-authority',
      name: 'Тестова институция',
      paidEur: 240_000,
      contracts: 6,
      sharePct: 0.75,
    },
  ],
  moreAuthorities: 2,
  procedureMix: [
    {
      key: 'open',
      label: 'Открита процедура',
      color: '#334455',
      competitive: true,
      contracts: 8,
      valueEur: 320_000,
      sharePct: 1,
    },
  ],
  bids: { one: 1, two: 2, three: 3, fourPlus: 1, unknown: 1 },
  topContracts: [contract],
  recentContracts: [contract],
  participants: [
    { name: '„ТЕСТ ГРУП“ ЕООД', eik: '111111111', resolvedSlug: '111111111' },
    { name: '„ПРИМЕР ПАРТНЬОР“ ООД', eik: null, resolvedSlug: null },
  ],
  membershipNote: null,
};

const trend: TrendData = {
  granularity: 'year',
  points: [
    { period: '2024', valueEur: 200_000, contracts: 5, partial: false },
    { period: '2025', valueEur: 120_000, contracts: 3, partial: true },
  ],
  years: [
    { year: '2024', valueEur: 200_000, contracts: 5, yoyPct: null, partial: false },
    { year: '2025', valueEur: 120_000, contracts: 3, yoyPct: null, partial: true },
  ],
  sectors: [],
  totalValueEur: 320_000,
  coverage: { dated: 8, total: 8, pct: 1 },
  scope: { sector: null, funding: 'all', granularity: 'year' },
};

const ties: CompanyTieNetwork = {
  center: {
    id: 'eik:123456789',
    kind: 'company',
    label: '„ТЕСТ ГРУП“ ДЗЗД',
    slug: 'test-group',
    valueEur: 320_000,
    hop: 0,
    conflictsHref: '/conflicts/company/123456789',
  },
  nodes: [
    {
      id: 'eik:123456789',
      kind: 'company',
      label: '„ТЕСТ ГРУП“ ДЗЗД',
      slug: 'test-group',
      valueEur: 320_000,
      hop: 0,
      conflictsHref: '/conflicts/company/123456789',
    },
    {
      id: 'eik:111111111',
      kind: 'company',
      label: '„ПРИМЕР ПАРТНЬОР“ ООД',
      slug: '111111111',
      valueEur: 80_000,
      hop: 1,
      conflictsHref: null,
    },
  ],
  edges: [
    {
      from: 'eik:123456789',
      to: 'eik:111111111',
      kind: 'consortium',
      directed: false,
      weightEur: 120_000,
      occurrences: 2,
      href: null,
    },
  ],
  omitted: 2,
};

const declarant: ConflictLink = {
  linkKey: 'test-person|123456789|family',
  officialSlug: 'test-person',
  official: 'ИВАН ПЕТРОВ ТЕСТОВ',
  institution: 'Тестова институция',
  position: 'Тестова длъжност',
  company: '„ТЕСТ ГРУП“ ДЗЗД',
  eik: '123456789',
  relation: 'related',
  contemporaneous: true,
  ownInstitution: false,
  firstDeclaredYear: '2023',
  lastDeclaredYear: '2025',
  contractCount: 8,
  contractValueEur: 320_000,
  contemporaneousContractCount: 3,
  contemporaneousValueEur: 120_000,
  firstContractYear: '2021',
  lastContractYear: '2025',
  sourceUrl: null,
  sourceYear: '2025',
  evidenceKind: 'document',
  registryRole: 'owner',
  registryEntryNumber: 'test-entry-1',
  registryEntryDate: '2020-01-01',
  registryLookupDate: '2026-09-01',
  declaredOffices: [
    { institution: 'Тестова институция', position: 'Тестова длъжност', year: '2025' },
  ],
};

const baseData = {
  company: richCompany,
  coverage: { asOf: '2026-09-01', refreshedAt: '2026-09-02', coverageEndYear: 2026 },
  trend,
  ties,
  people: {
    asOf: '2026-09-01',
    roles: [
      {
        holder: {
          kind: 'person' as const,
          name: 'ИВАН ПЕТРОВ ТЕСТОВ',
          href: '/persons/test-person',
          eik: null,
          country: null,
        },
        role: 'manager' as const,
        share: null,
        sharePct: null,
        addedOn: '2020-01-01',
        removedOn: null,
        entryNumber: 'test-entry-1',
      },
    ],
  },
  declarants: [declarant],
  jointContracts: [
    {
      id: 'contract-test-2',
      subject: 'Съвместна тестова доставка',
      signedAt: '2024-02-01',
      valueEur: 45_000,
      authority: 'Тестова институция',
      authorityId: 'auth:test-authority',
      groupName: '„ТЕСТ ГРУП“ ДЗЗД',
    },
  ],
  tieLayout: layoutTies(ties),
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
    { path: '/companies/:eik', Component: Company, loader: () => loaderData },
  ]);
  await act(async () => {
    root.render(<Stub initialEntries={['/companies/test-group']} />);
  });
}

const section = (id: string) => container.querySelector(`#${id}`)?.closest('section') ?? null;

describe('/companies/:eik — procurement profile', () => {
  it('renders the complete consortium profile and every source-backed section', async () => {
    await mount(baseData);

    expect(container.querySelector('h1')?.textContent).toBe('„Тест Груп“ и партньори');
    expect(container.querySelector('.kicker')?.textContent).toContain('Група изпълнители');
    expect(container.querySelector('.kicker')?.textContent).toContain('дял на свързано лице');
    expect(container.textContent).toContain('Общо спечелено');
    expect(container.textContent).toContain('Непотвърдена стойност');
    expect(section('joint-contracts')?.textContent).toContain('Съвместна тестова доставка');

    const participants = section('participants')!;
    expect(participants.querySelectorAll('li')).toHaveLength(2);
    expect(participants.querySelector('a')?.getAttribute('href')).toBe('/companies/111111111');
    expect(section('trend')).not.toBeNull();
    expect(section('how-win')?.textContent).toContain('Открита процедура');
    expect(section('bids')?.textContent).toContain('няма данни');
    expect(section('from')?.textContent).toContain('още 2 институции');
    expect(section('people')?.textContent).toContain('Иван Петров Тестов');
    expect(section('network')?.textContent).toContain('още 2 са извън схемата');
    expect(section('latest')?.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('explains a procurement participant without a confirmed EIK and hides contract-only sections', async () => {
    const company: CompanyDetail = {
      ...richCompany,
      slug: 'test-participant',
      name: 'ТЕСТОВ УЧАСТНИК',
      displayName: 'ТЕСТОВ УЧАСТНИК',
      kind: 'company',
      isConsortium: false,
      eik: null,
      hasEik: false,
      ownershipKind: null,
      settlement: null,
      region: null,
      wonEur: 0,
      contracts: 0,
      authorities: 0,
      sector: null,
      sectorSharePct: null,
      euSharePct: 0,
      avgBids: null,
      periodFirst: null,
      periodLast: null,
      suspect: 0,
      topAuthorities: [],
      moreAuthorities: 0,
      procedureMix: [],
      bids: { one: 0, two: 0, three: 0, fourPlus: 0, unknown: 0 },
      topContracts: [],
      recentContracts: [],
      participants: [],
      membershipNote: null,
    };
    await mount({
      ...baseData,
      company,
      ties: { center: null, nodes: [], edges: [], omitted: 0 },
      people: { asOf: null, roles: [] },
      declarants: [],
      jointContracts: [],
      tieLayout: null,
    });

    expect(container.querySelector('.kicker')?.textContent).toContain('Участник');
    expect(container.querySelector('.kicker')?.textContent).toContain('без ЕИК');
    expect(container.textContent).toContain('Без публикуван идентификатор');
    expect(container.textContent).toContain('участник без потвърден идентификатор');
    expect(section('trend')).toBeNull();
    expect(section('people')).toBeNull();
    expect(section('network')?.textContent).toContain('Не намираме връзки');
    expect(section('latest')).toBeNull();
  });

  it('quotes a consortium membership note when the source has no structured member list', async () => {
    await mount({
      ...baseData,
      company: {
        ...richCompany,
        contracts: 0,
        participants: [],
        membershipNote: 'Тестово описание на участниците в обединението.',
      },
      declarants: [],
      jointContracts: [],
      tieLayout: null,
    });

    expect(section('participants')?.querySelector('h2')?.textContent).toBe(
      'Описание на обединението',
    );
    expect(section('participants')?.querySelector('blockquote')?.textContent).toBe(
      'Тестово описание на участниците в обединението.',
    );
  });
});

describe('/companies/:eik — meta', () => {
  const titleOf = (tags: ReturnType<typeof meta>) =>
    tags.find((tag): tag is { title: string } => 'title' in tag)?.title;

  it('describes a procurement profile and builds its canonical URL', () => {
    const tags = meta({
      data: baseData,
      params: { eik: 'test-group' },
      matches: [{ id: 'root', data: { origin: 'https://sigma.test' } }],
    } as never);
    expect(titleOf(tags)).toBe('„Тест Груп“ и партньори — СИГМА');
    expect(tags).toContainEqual({
      tagName: 'link',
      rel: 'canonical',
      href: 'https://sigma.test/companies/test-group',
    });
    expect(tags.find((tag) => 'name' in tag && tag.name === 'description')).toEqual({
      name: 'description',
      content: 'Профил на „Тест Груп“ и партньори в обществените поръчки 2020–2026.',
    });
  });

  it('uses a generic fallback on errors and noindexes a sole-trader procurement profile', () => {
    const fallback = meta({ data: undefined, params: { eik: 'missing' }, matches: [] } as never);
    expect(titleOf(fallback)).toBe('Компания — СИГМА');

    const naturalPerson = meta({
      data: {
        ...baseData,
        company: {
          ...richCompany,
          name: 'ЕТ ИВАН ПЕТРОВ ТЕСТОВ',
          displayName: 'ЕТ ИВАН ПЕТРОВ ТЕСТОВ',
          legalForm: 'ET',
        },
      },
      params: { eik: '123456789' },
      matches: [],
    } as never);
    expect(naturalPerson).toContainEqual({ name: 'robots', content: 'noindex' });
  });
});
