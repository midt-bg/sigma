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
  getDb: (env: unknown) => (env as { DB: unknown }).DB,
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

describe('company.data loader — consortium-with-sole-trader-first-member branch (mirror of contract.tsx/contract.json.tsx)', () => {
  it('does NOT over-mask a consortium whose displayName starts with "ЕТ " — keeps ЕИК, no privacy marker (regression for company.tsx consortium guard)', async () => {
    // A ДЗЗД (consortium) whose first member is a sole trader has a display name beginning
    // "ЕТ …". `isNaturalPersonBidder` delegates consortium filtering to the caller, so without
    // the explicit `kind !== 'consortium'` guard the loader would zero the consortium's ЕИК and
    // stamp noindex — the same over-masking bug that contract.tsx / contract.json.tsx guard against
    // (MAJOR 1 in the PR #183 review). The fix mirrors those guards: the consortium branch must
    // return the plain object with company.eik unchanged and no marker.
    const consortiumWithSoleTraderFirst = makeCompany({
      kind: 'consortium',
      isConsortium: true,
      legalForm: null,
      displayName: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ; СТРОЙ ООД',
      name: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ; СТРОЙ ООД',
      eik: '121817309',
    });
    installStubs(consortiumWithSoleTraderFirst);

    const result = await loader(loaderArgs('121817309'));

    expect(result).not.toBeInstanceOf(Response);
    const plain = result as { company: CompanyDetail };
    expect(plain.company.eik).toBe('121817309');
    expect(plain.company.displayName).toBe('ЕТ ДРИФТ - НИКОЛАЙ КИРОВ; СТРОЙ ООД');
  });
});

describe('company.data loader — natural-person branch', () => {
  it('masks only the ЕИК (sensitive ID), keeps the public trading displayName, and marks noindex (behaviors 1 + 2)', async () => {
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
    // ЕИК is the sensitive natural-person identifier → masked.
    expect(body.company.eik).toBeNull();
    // displayName is the PUBLIC trading name, rendered verbatim on the HTML page; the `.data` twin
    // is React Router's single-fetch transport for client navigations (NOT a standalone export like
    // /contracts/:id.json), so the name must stay verbatim or client-rendered pages break. Only the
    // ЕИК is masked. This locks the policy decision recorded in ADR-0039 §3 + PR #183 review.
    expect(body.company.displayName).toBe('ЕТ ДРИФТ - НИКОЛАЙ КИРОВ');
  });

  it('keeps the masking signal consistent across eik / eikValid / hasEik (ydimitrof review 2026-08-31, thread on company.tsx:114)', async () => {
    // The company-profile loader must zero `eikValid` and `hasEik` alongside `eik` so a consumer
    // never sees a payload of `eik: null, eikValid: true, hasEik: false` — that combination
    // would render a „валиден ЕИК" badge next to an empty value (the same invariant the
    // leaderboard mapper enforces via toCompanyListItem).
    const natural = makeCompany({
      legalForm: 'ЕТ',
      displayName: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ',
      eik: '123456789',
      eikValid: true,
      hasEik: true,
    });
    installStubs(natural);

    const result = await loader(loaderArgs('123456789'));
    expect(result).toBeInstanceOf(Response);
    const body = (await (result as Response).json()) as { company: CompanyDetail };

    expect(body.company.eik).toBeNull();
    expect(body.company.eikValid).toBe(false);
    expect(body.company.hasEik).toBe(false);
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
  // The company-profile (`/companies/:eik`) HTML page is a SINGLE-RECORD page, not a leaderboard
  // list. A masked sole-trader record is fully replaced with `MASKED_NATURAL_PERSON_LABEL` and
  // a null ЕИК; the meta tag (`meta()` above) also adds `<meta robots noindex>`. Forwarding the
  // marker to the HTML response is belt-and-braces with the meta tag, NOT a regression. The
  // leaderboard (`/companies`) is the only surface where forwarding is undesirable (ydimitrof
  // review 2026-08-31, thread on apps/web/app/routes/companies.tsx:61); see companies.render.test.tsx.
  it('returns X-Privacy-Mask + Cache-Control when the loader set the marker', () => {
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

  it('returns only Cache-Control when loaderHeaders carry no marker', () => {
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

describe('company.data meta() — consortium-with-sole-trader-first-member branch', () => {
  it('does NOT emit a noindex meta tag for a consortium whose displayName starts with "ЕТ " (mirrors the loader consortium guard)', () => {
    // The loader (lines ~96-105 of company.tsx) gates masking on
    // `company.kind !== 'consortium'`, returning a plain object (no privacy marker) for a ДЗЗД
    // whose first member is a sole trader. `meta()` must mirror that guard — without it,
    // `isNaturalPersonBidder(displayName, legalForm)` returns `true` for "ЕТ …; СТРОЙ ООД"
    // (legalForm null), and `meta()` would stamp `<meta name="robots" content="noindex">` on a
    // HTML page that the loader and `.data` twin agree is indexable. That contradicts the
    // policy recorded in ADR-0039 §3 + the consortium guard added in 5d33ea5.
    //
    // Regression caught by ydimitrof in the PR #183 review of head a13e9a5 (the only unresolved
    // thread on this PR).
    const consortiumWithSoleTraderFirst = makeCompany({
      kind: 'consortium',
      isConsortium: true,
      legalForm: null,
      displayName: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ; СТРОЙ ООД',
      name: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ; СТРОЙ ООД',
      eik: '121817309',
    });
    const data = {
      company: consortiumWithSoleTraderFirst,
      coverage: makeCoverageMeta(),
      trend: makeTrend(),
      network: makeNetwork(),
    };

    const tags = meta({
      data,
      params: { eik: '121817309' },
      matches: [],
      location: {
        pathname: '/companies/121817309',
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
    expect(robots).toBeUndefined();
  });

  it('still emits noindex for a prose-consortium (kind=consortium, membershipNote set) so policy does not regress', () => {
    // The prose branch was added intentionally: when the consortium parser returns raw prose
    // (single-name consortium the parser couldn't resolve), the membership note itself can carry
    // identifying names and the page is noindexed. The consortium-with-sole-trader-first-member
    // guard must not regress this case.
    const proseConsortium = makeCompany({
      kind: 'consortium',
      isConsortium: true,
      legalForm: null,
      displayName: 'КОНСОРЦИУМ ПЪРВА ГРУПА',
      name: 'КОНСОРЦИУМ ПЪРВА ГРУПА',
      eik: '121817309',
      membershipNote: 'КОНСОРЦИУМ ПЪРВА ГРУПА',
    });
    const data = {
      company: proseConsortium,
      coverage: makeCoverageMeta(),
      trend: makeTrend(),
      network: makeNetwork(),
    };

    const tags = meta({
      data,
      params: { eik: '121817309' },
      matches: [],
      location: {
        pathname: '/companies/121817309',
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

describe('company.data loader — prose-consortium (kind=consortium, membershipNote) branch', () => {
  it('sets X-Privacy-Mask: applied WITHOUT zeroing the consortium ЕИК (the same noindex policy as meta() applies to the .data twin)', async () => {
    // Prose consortia are single-name consortium records the parser couldn't resolve into structured
    // members; their `membershipNote` itself can carry identifying names (per the meta() comment at
    // company.tsx:42-49). The HTML page already emits <meta robots noindex> for this branch (see the
    // dedicated meta() test "still emits noindex for a prose-consortium"). The .data twin must carry
    // the same noindex signal — otherwise the machine-readable twin leaks the same membership-note
    // content indexable to crawlers that don't honour <meta>. The ЕИК of the consortium stays
    // public (it's a legal entity), so the loader sets the marker without clearing company.eik.
    const proseConsortium = makeCompany({
      kind: 'consortium',
      isConsortium: true,
      legalForm: null,
      displayName: 'КОНСОРЦИУМ ПЪРВА ГРУПА',
      name: 'КОНСОРЦИУМ ПЪРВА ГРУПА',
      eik: '121817309',
      membershipNote: 'КОНСОРЦИУМ ПЪРВА ГРУПА',
    });
    installStubs(proseConsortium);

    const result = await loader(loaderArgs('121817309'));

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Privacy-Mask')).toBe('applied');
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
    const body = (await response.json()) as { company: CompanyDetail };
    // Consortium ЕИК is public (legal entity) — must not be zeroed by this branch.
    expect(body.company.eik).toBe('121817309');
    // membershipNote is part of the response body (preserved verbatim) — the noindex signal on the
    // .data twin is what protects it from indexing.
    expect(body.company.membershipNote).toBe('КОНСОРЦИУМ ПЪРВА ГРУПА');
  });

  it('returns a plain object (no marker) when kind=consortium but membershipNote is null — the prose guard does not over-trigger', async () => {
    // The prose-consortium branch fires on `membershipNote` presence, not on the kind alone. A
    // consortium whose parser was able to resolve structured members has membershipNote === null
    // and must stay indexable (mirrors the consortium-with-sole-trader-first-member guard).
    const structuredConsortium = makeCompany({
      kind: 'consortium',
      isConsortium: true,
      legalForm: null,
      displayName: 'СТРОЙ ООД; ПЪТ ИНЖЕНЕРИНГ АД',
      name: 'СТРОЙ ООД; ПЪТ ИНЖЕНЕРИНГ АД',
      eik: '121817309',
      membershipNote: null,
    });
    installStubs(structuredConsortium);

    const result = await loader(loaderArgs('121817309'));

    expect(result).not.toBeInstanceOf(Response);
    const plain = result as { company: CompanyDetail };
    expect(plain.company.eik).toBe('121817309');
    expect(plain.company.membershipNote).toBeNull();
  });

  it('translates the prose-consortium X-Privacy-Mask marker into X-Robots-Tag: noindex via the worker pipeline', async () => {
    // End-to-end proof that the loader-set marker reaches a noindex header on the .data response
    // (mirrors the natural-person worker-pipeline case but does not zero the ЕИК).
    const proseConsortium = makeCompany({
      kind: 'consortium',
      isConsortium: true,
      legalForm: null,
      displayName: 'КОНСОРЦИУМ ПЪРВА ГРУПА',
      name: 'КОНСОРЦИУМ ПЪРВА ГРУПА',
      eik: '121817309',
      membershipNote: 'КОНСОРЦИУМ ПЪРВА ГРУПА',
    });
    installStubs(proseConsortium);

    const result = await loader(loaderArgs('121817309'));
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;

    applyPrivacyMaskHeaders(response.headers);

    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(response.headers.has('X-Privacy-Mask')).toBe(false);
    const body = (await response.json()) as { company: CompanyDetail };
    expect(body.company.eik).toBe('121817309');
    expect(body.company.membershipNote).toBe('КОНСОРЦИУМ ПЪРВА ГРУПА');
  });
});
