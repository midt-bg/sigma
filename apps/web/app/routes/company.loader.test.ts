import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The company loader joins procurement and Trade Register data. Keep the query layer mocked here:
// these tests pin the routing decisions, optional reads and indexing headers without needing D1.
const q = vi.hoisted(() => ({
  bidderIdFromSlug: vi.fn((slug: string) => (/^\d{9}$/.test(slug) ? `eik:${slug}` : null)),
  contractSlug: vi.fn((id: string) => id),
  getCompany: vi.fn(),
  getCompanyDeclarants: vi.fn(),
  getParticipantContracts: vi.fn(),
  getCompanyPeople: vi.fn(),
  getCompanyTies: vi.fn(),
  getRegistryCompany: vi.fn(),
  getSpendingTrend: vi.fn(),
  getDb: vi.fn((env: { DB: unknown }) => env.DB),
}));
vi.mock('@sigma/db', () => q);

import { headers, loader } from './company';

const DB = {
  prepare: vi.fn(() => ({
    first: vi.fn(async () => ({ as_of: '2026-09-01', refreshed_at: '2026-09-02' })),
  })),
};
const context = { cloudflare: { env: { DB } } };
const ties = { center: null, nodes: [], edges: [], omitted: 0 };
const people = { roles: [], asOf: null };
const trend = {
  granularity: 'year',
  points: [],
  years: [],
  sectors: [],
  totalValueEur: 0,
  coverage: { dated: 0, total: 0, pct: 0 },
  scope: { sector: null, funding: 'all', granularity: 'year' },
};

const company = {
  slug: '123456789',
  name: '„ТЕСТ ГРУП“ ЕООД',
  displayName: '„ТЕСТ ГРУП“ ЕООД',
  kind: 'company',
  isConsortium: false,
  eik: '123456789',
  hasEik: true,
  ownershipKind: null,
  settlement: 'гр. Тестово',
  region: 'Тестова област',
  legalForm: 'EOOD',
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

const call = (eik: string | undefined) =>
  (loader as (args: unknown) => Promise<unknown>)({ params: { eik }, context });

async function expectStatus(promise: Promise<unknown>, status: number) {
  try {
    await promise;
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(status);
    return;
  }
  throw new Error(`expected a ${status} Response to be thrown, but the loader resolved`);
}

beforeEach(() => {
  q.getCompany.mockResolvedValue(company);
  q.getCompanyDeclarants.mockResolvedValue([]);
  q.getParticipantContracts.mockResolvedValue([]);
  q.getCompanyPeople.mockResolvedValue(people);
  q.getCompanyTies.mockResolvedValue(ties);
  q.getRegistryCompany.mockResolvedValue(null);
  q.getSpendingTrend.mockResolvedValue(trend);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('company loader', () => {
  it.each([undefined, '', '   ', 'not-an-eik'])(
    '404s an absent or invalid company slug (%s) before reading D1',
    async (eik) => {
      await expectStatus(call(eik), 404);
      expect(q.getCompany).not.toHaveBeenCalled();
      expect(q.getDb).not.toHaveBeenCalled();
    },
  );

  it('404s when neither procurement nor the Trade Register knows the company', async () => {
    q.getCompany.mockResolvedValue(null);
    await expectStatus(call('123456789'), 404);
    expect(q.getRegistryCompany).toHaveBeenCalledWith(DB, 'eik:123456789');
  });

  it('returns a register-only company and keeps a sole trader out of search indices', async () => {
    q.getCompany.mockResolvedValue(null);
    q.getRegistryCompany.mockResolvedValue({
      eik: '123456789',
      name: 'ЕТ ИВАН ПЕТРОВ ТЕСТОВ',
      legalForm: 'ET',
      seat: 'гр. Тестово',
      inLiquidation: false,
      asOf: '2026-09-01',
    });

    const response = (await call('123456789')) as {
      data: { registry: { name: string }; tieLayout: null };
      init: { headers: Record<string, string> };
    };
    expect(response.data.registry.name).toBe('ЕТ ИВАН ПЕТРОВ ТЕСТОВ');
    expect(response.data.tieLayout).toBeNull();
    expect(response.init.headers).toEqual({ 'X-Robots-Tag': 'noindex' });
    expect(q.getCompanyDeclarants).not.toHaveBeenCalled();
    expect(q.getParticipantContracts).not.toHaveBeenCalled();
  });

  it('loads declarants and joint contracts only when the procurement record needs them', async () => {
    q.getCompany.mockResolvedValue({ ...company, legalForm: 'ET' });
    q.getCompanyTies.mockResolvedValue({
      ...ties,
      center: { conflictsHref: '/conflicts/company/123456789' },
    });
    q.getCompanyDeclarants.mockResolvedValue([{ official: 'ИВАН ПЕТРОВ ТЕСТОВ' }]);
    q.getParticipantContracts.mockResolvedValue([{ id: 'contract-test-1' }]);

    const response = (await call('123456789')) as {
      data: { declarants: unknown[]; jointContracts: unknown[] };
      init: { headers: Record<string, string> };
    };
    expect(q.getCompanyDeclarants).toHaveBeenCalledWith(DB, '123456789');
    expect(q.getParticipantContracts).toHaveBeenCalledWith(DB, 'eik:123456789');
    expect(response.data.declarants).toHaveLength(1);
    expect(response.data.jointContracts).toHaveLength(1);
    expect(response.init.headers).toEqual({ 'X-Robots-Tag': 'noindex' });
  });

  it('skips optional reads for a company with contracts and no declarant link', async () => {
    q.getCompany.mockResolvedValue({
      ...company,
      contracts: 2,
      eik: null,
      hasEik: false,
    });

    const response = (await call('123456789')) as {
      data: { declarants: unknown[]; jointContracts: unknown[] };
      init: { headers: Record<string, string> };
    };
    expect(response.data.declarants).toEqual([]);
    expect(response.data.jointContracts).toEqual([]);
    expect(response.init.headers).toEqual({});
    expect(q.getCompanyDeclarants).not.toHaveBeenCalled();
    expect(q.getParticipantContracts).not.toHaveBeenCalled();
  });
});

it('preserves loader headers and applies the public one-hour cache policy', () => {
  const result = headers({
    loaderHeaders: new Headers({ 'X-Robots-Tag': 'noindex', 'X-Test': 'kept' }),
  } as never);
  expect(result.get('Cache-Control')).toBe('public, s-maxage=3600, stale-while-revalidate=86400');
  expect(result.get('X-Robots-Tag')).toBe('noindex');
  expect(result.get('X-Test')).toBe('kept');
});
