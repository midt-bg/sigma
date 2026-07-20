import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyDetail, NetworkData, TrendData } from '@sigma/api-contract';
import { bidderIdFromSlug, getCompany, getEntityNetwork, getSpendingTrend } from '@sigma/db';
import { applyPrivacyMaskHeaders } from '../lib/security';
import type { CoverageMeta } from '../lib/coverage';
import { getCoverageMeta } from '../lib/coverage';
import { headers, loader, meta } from './company';

vi.mock('@sigma/db', () => ({
  bidderIdFromSlug: vi.fn((slug: string) => (/^\d{9}(\d{4})?$/.test(slug) ? 'eik:' + slug : null)),
  getCompany: vi.fn(),
  getSpendingTrend: vi.fn(),
  getEntityNetwork: vi.fn(),
}));

vi.mock('../lib/coverage', async () => {
  const actual = await vi.importActual<typeof import('../lib/coverage')>('../lib/coverage');
  return {
    ...actual,
    getCoverageMeta: vi.fn(),
    coverageRange: actual.coverageRange,
  };
});

function makeCoverageMeta(): CoverageMeta {
  return { asOf: '2025-06-30', refreshedAt: '2025-07-01T00:00:00Z', coverageEndYear: 2025 };
}

function makeTrend(): TrendData {
  return {
    granularity: 'month',
    points: [],
    years: [],
    sectors: [],
    totalValueEur: 0,
    coverage: { dated: 0, total: 0, pct: 0 },
    scope: { sector: null, funding: 'all', granularity: 'month' },
  };
}

function makeNetwork(): NetworkData {
  return {
    center: null,
    nodes: [],
    edges: [],
    centerOptions: { authorities: [], companies: [] },
  };
}

function makeCompany(overrides: Partial<CompanyDetail> = {}): CompanyDetail {
  return {
    slug: 'company-slug',
    name: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ',
    displayName: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ',
    kind: 'company',
    isConsortium: false,
    eik: '123456789',
    eikValid: true,
    hasEik: true,
    ownershipKind: null,
    settlement: 'Plovdiv',
    region: null,
    legalForm: 'ЕТ',
    wonEur: 1000,
    contracts: 1,
    authorities: 1,
    sector: null,
    sectorSharePct: null,
    euSharePct: 0,
    avgBids: 1,
    periodFirst: '2024-01-01',
    periodLast: '2024-01-01',
    suspect: 0,
    topAuthorities: [
      {
        slug: 'authority-slug',
        name: 'Some Authority',
        paidEur: 1000,
        contracts: 1,
        sharePct: 1,
      },
    ],
    moreAuthorities: 0,
    procedureMix: [],
    bids: { one: 1, two: 0, three: 0, fourPlus: 0, unknown: 0 },
    topContracts: [],
    recentContracts: [],
    participants: [],
    membershipNote: null,
    ...overrides,
  };
}

function loaderArgs(eik: string | undefined): Parameters<typeof loader>[0] {
  return {
    params: { eik: eik ?? '' },
    context: { cloudflare: { env: { DB: {} as never } } },
  } as unknown as Parameters<typeof loader>[0];
}

function installStubs(company: CompanyDetail | null): void {
  vi.mocked(getCompany).mockResolvedValueOnce(company);
  vi.mocked(getCoverageMeta).mockResolvedValueOnce(makeCoverageMeta());
  vi.mocked(getSpendingTrend).mockResolvedValueOnce(makeTrend());
  vi.mocked(getEntityNetwork).mockResolvedValueOnce(makeNetwork());
}

beforeEach(() => {
  vi.mocked(getCompany).mockReset();
  vi.mocked(getCoverageMeta).mockReset();
  vi.mocked(getSpendingTrend).mockReset();
  vi.mocked(getEntityNetwork).mockReset();
});

describe('company.data loader — natural-person branch', () => {
  it('returns a Response carrying X-Privacy-Mask: applied with company.eik === null (behaviors 1 + 2)', async () => {
    const natural = makeCompany({ legalForm: 'ЕТ', displayName: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ' });
    installStubs(natural);

    const result = await loader(loaderArgs('123456789'));

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Privacy-Mask')).toBe('applied');
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
    const body = (await response.json()) as {
      company: { eik: string | null; displayName: string };
    };
    expect(body.company.eik).toBeNull();
    expect(body.company.displayName).toBe('ЕТ ДРИФТ - НИКОЛАЙ КИРОВ');
  });
});

describe('company.data loader — legal-entity branch', () => {
  it('returns a plain object (not a Response) with company.eik unchanged and no privacy marker (behavior 3)', async () => {
    const legal = makeCompany({
      legalForm: 'АД',
      displayName: 'СОФАРМА ТРЕЙДИНГ АД',
      eik: '121817309',
    });
    installStubs(legal);

    const result = await loader(loaderArgs('121817309'));

    expect(result).not.toBeInstanceOf(Response);
    const plain = result as {
      company: CompanyDetail;
      coverage: CoverageMeta;
      trend: TrendData;
      network: NetworkData;
    };
    expect(plain.company.eik).toBe('121817309');
    expect(plain.company.displayName).toBe('СОФАРМА ТРЕЙДИНГ АД');
    expect(plain.coverage.coverageEndYear).toBe(2025);
  });
});

describe('company.data headers() — forwards the privacy mask marker', () => {
  it('returns X-Privacy-Mask + Cache-Control when the loader set the marker (behavior 4)', () => {
    const loaderHeaders = new Headers({ 'X-Privacy-Mask': 'applied' });

    const result = headers({
      loaderHeaders,
      parentHeaders: new Headers(),
      actionHeaders: new Headers(),
      errorHeaders: undefined,
    } as unknown as Parameters<typeof headers>[0]);

    expect(result['Cache-Control']).toBe('public, s-maxage=3600, stale-while-revalidate=86400');
    expect(result['X-Privacy-Mask']).toBe('applied');
  });

  it('returns only Cache-Control when loaderHeaders carry no marker (behavior 5)', () => {
    const loaderHeaders = new Headers();

    const result = headers({
      loaderHeaders,
      parentHeaders: new Headers(),
      actionHeaders: new Headers(),
      errorHeaders: undefined,
    } as unknown as Parameters<typeof headers>[0]);

    expect(result['Cache-Control']).toBe('public, s-maxage=3600, stale-while-revalidate=86400');
    expect('X-Privacy-Mask' in result).toBe(false);
  });
});

describe('company.data meta() — natural-person noindex branch', () => {
  it('emits { name: robots, content: noindex } for a natural-person data payload (behavior 6)', () => {
    const natural = makeCompany({ legalForm: 'ЕТ', displayName: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ' });
    const data = {
      company: natural,
      coverage: makeCoverageMeta(),
      trend: makeTrend(),
      network: makeNetwork(),
    };

    const tags = meta({
      data,
      params: { eik: '123456789' },
      matches: [],
      location: {
        pathname: '/companies/123456789',
        search: '',
        hash: '',
        state: null,
        key: 'default',
      },
    } as unknown as Parameters<typeof meta>[0]) as Array<{
      name?: string;
      content?: string;
      title?: string;
    }>;

    const robots = tags.find((t) => t.name === 'robots' && t.content === 'noindex');
    expect(robots).toBeDefined();
    expect(robots).toMatchObject({ name: 'robots', content: 'noindex' });
  });
});

describe('company.data worker pipeline — applyPrivacyMaskHeaders on the loader return', () => {
  it('translates X-Privacy-Mask: applied into X-Robots-Tag: noindex and removes the marker (behavior 7)', async () => {
    const natural = makeCompany({ legalForm: 'ЕТ', displayName: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ' });
    installStubs(natural);

    const result = await loader(loaderArgs('123456789'));
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;

    applyPrivacyMaskHeaders(response.headers);

    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(response.headers.has('X-Privacy-Mask')).toBe(false);
  });

  it('leaves X-Robots-Tag unset and removes any pre-existing marker when the loader did not set it', async () => {
    const legal = makeCompany({
      legalForm: 'АД',
      displayName: 'СОФАРМА ТРЕЙДИНГ АД',
      eik: '121817309',
    });
    installStubs(legal);

    const result = await loader(loaderArgs('121817309'));
    expect(result).not.toBeInstanceOf(Response);
    const plain = result as {
      company: CompanyDetail;
      coverage: CoverageMeta;
      trend: TrendData;
      network: NetworkData;
    };

    const outHeaders = new Headers();
    if (plain.company.displayName) {
      outHeaders.set('X-Passthrough', '1');
    }
    applyPrivacyMaskHeaders(outHeaders);

    expect(outHeaders.has('X-Robots-Tag')).toBe(false);
    expect(outHeaders.has('X-Privacy-Mask')).toBe(false);
    expect(outHeaders.get('X-Passthrough')).toBe('1');
  });
});
