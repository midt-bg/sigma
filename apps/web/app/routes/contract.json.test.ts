import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractRecord } from '@sigma/api-contract';
import { MASKED_NATURAL_PERSON_LABEL } from '@sigma/shared';

vi.mock('@sigma/db', async (importOriginal) => {
  // PR #183 review (ydimitrof 2026-09-03, thread on contract.json.tsx:39): the masker now also
  // imports `maskedCompanySlug` to replace the bidder slug with an opaque token. The mock must
  // forward that named export so the production function is exercised rather than `undefined`.
  const actual = await importOriginal<typeof import('@sigma/db')>();
  return {
    ...actual,
    getContract: vi.fn(),
    getDb: (env: unknown) => (env as { DB: unknown }).DB,
    contractIdFromSlug: (slug: string) => 'c:' + slug,
  };
});

import { getContract } from '@sigma/db';
import { loader, maskContractForPrivacy } from './contract.json';

function makeRecord(overrides: Partial<ContractRecord> = {}): ContractRecord & {
  bidder_legal_form: string | null;
  bidder_id: string;
} {
  return {
    id: 'c-1',
    subject: 'Sample contract',
    unp: '00001-2024-0001',
    contractNumber: null,
    documentNumber: null,
    eopTenderId: null,
    lotLabel: null,
    signedAt: '2024-01-01',
    publishedAt: null,
    dateSuspect: false,
    startDate: null,
    endDate: null,
    contractKind: null,
    cpvCode: null,
    cpvDescription: null,
    sector: null,
    procedureLabel: 'Открита',
    bidsReceived: 1,
    bidsRejected: 0,
    bidsSme: 0,
    bidsNonEea: 0,
    euFunded: false,
    euProgramme: null,
    durationDays: null,
    value: {
      estimatedEur: 1000,
      procedureEstimatedEur: 1000,
      signingEur: 1000,
      currentEur: 1000,
      deltaPct: 0,
      suspect: false,
      currentValueDoubled: false,
    },
    frameworkAwards: null,
    authority: {
      slug: 'auth-1',
      orderingUnit: null,
      name: 'Some Authority',
      displayName: 'Some Authority',
      typeLabel: null,
      settlement: 'Sofia',
      eik: '000000000',
      sector: null,
      totalContracts: 1,
      totalEur: 1000,
    },
    bidder: {
      slug: 'bidder-1',
      orderingUnit: null,
      name: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ',
      displayName: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ',
      kind: 'company',
      typeLabel: null,
      settlement: 'Plovdiv',
      eik: '123456789',
      sector: null,
      totalContracts: 1,
      totalEur: 1000,
    },
    lots: null,
    subcontractor: null,
    cohort: null,
    amendments: [],
    sourceNames: {
      authority: 'Some Authority',
      bidder: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ',
    },
    bidder_legal_form: 'ЕТ',
    bidder_id: 'eik:123456789',
    ...overrides,
  };
}

function loaderArgs(id: string): Parameters<typeof loader>[0] {
  return {
    params: { id },
    context: { cloudflare: { env: { DB: {} as never } } },
  } as unknown as Parameters<typeof loader>[0];
}

describe('maskContractForPrivacy', () => {
  it('masks bidder fields and returns a new object when legal_form identifies a sole trader', () => {
    const record = makeRecord();
    const masked = maskContractForPrivacy(record, record.bidder_legal_form);
    expect(masked).not.toBe(record);
    expect(masked.bidder.eik).toBeNull();
    expect(masked.bidder.name).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(masked.bidder.displayName).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(masked.sourceNames.bidder).toBe(MASKED_NATURAL_PERSON_LABEL);
    // PR #183 review (ydimitrof 2026-09-03, thread on contract.json.tsx:39): the masker replaces
    // `bidder.slug` with the opaque `maskedCompanySlug` token so the response body does not carry
    // a bare ЕИК. The masked profile is reachable only via direct URL or a noindexed contract
    // page backlink.
    expect(masked.bidder.slug).toMatch(/^m[0-9a-f]{16}$/);
    expect(masked.bidder.slug).not.toBe('bidder-1');
    expect(masked.bidder.totalEur).toBe(1000);
    // The server-only fields (bidder_id, bidder_legal_form) must NOT leak into the masked output.
    expect('bidder_id' in masked).toBe(false);
    expect('bidder_legal_form' in masked).toBe(false);
  });

  it('returns the input by reference when the bidder is a legal entity', () => {
    const record = makeRecord({
      bidder: {
        slug: 'bidder-2',
        orderingUnit: null,
        name: 'СОФАРМА ТРЕЙДИНГ АД',
        displayName: 'СОФАРМА ТРЕЙДИНГ АД',
        kind: 'company',
        typeLabel: null,
        settlement: 'Sofia',
        eik: '123456789',
        sector: null,
        totalContracts: 1,
        totalEur: 1000,
      },
      sourceNames: {
        authority: 'Some Authority',
        bidder: 'СОФАРМА ТРЕЙДИНГ АД',
      },
    });
    record.bidder_legal_form = 'АД';
    const masked = maskContractForPrivacy(record, record.bidder_legal_form);
    expect(masked).toBe(record);
    expect(masked.bidder.eik).toBe('123456789');
    expect(masked.bidder.name).toBe('СОФАРМА ТРЕЙДИНГ АД');
    expect(masked.sourceNames.bidder).toBe('СОФАРМА ТРЕЙДИНГ АД');
  });

  it('does NOT carry a bare ЕИК in the masked body (PR #183 review, ydimitrof 2026-09-03, thread on contract.json.tsx:39)', () => {
    // Regression: the previous masker kept `bidder.slug` (a bare ЕИК for `eik:<digits>` bidder
    // ids) in the masked body. The fix substitutes the opaque `maskedCompanySlug` token and
    // strips `bidder_id` from the public output, so the response body contains no identifier
    // — neither the bare ЕИК nor a base64url-encoded form of it nor the raw bidder_id key.
    const record = makeRecord();
    const masked = maskContractForPrivacy(record, record.bidder_legal_form);
    const body = JSON.stringify(masked);
    expect(body).not.toContain('123456789'); // the bare ЕИК
    expect(body).not.toContain('eik:123456789'); // the bidder_id key
    expect(body).not.toContain(record.bidder.slug); // the unmasked slug (which was the source leak)
  });

  it('masks when legal_form is null but the name starts with the leading-ЕТ heuristic', () => {
    const record = makeRecord();
    record.bidder_legal_form = null;
    const masked = maskContractForPrivacy(record, null);
    expect(masked).not.toBe(record);
    expect(masked.bidder.eik).toBeNull();
    expect(masked.bidder.name).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(masked.sourceNames.bidder).toBe(MASKED_NATURAL_PERSON_LABEL);
  });

  it('does NOT mask a consortium whose first member is a sole trader (kind=consortium guard)', () => {
    // Real-world shape: a JV whose display name begins with "ЕТ " because the first member is a sole
    // trader ("ЕТ Иван Петров; Строй ООД"). The CSV streamer already gates this with `bidder_kind !==
    // 'consortium'` (contracts.ts:459); the JSON masker must apply the same guard so a consortium is
    // never over-masked to "Частно лице" — it keeps the "… и др." shape, the consortium ЕИК, and no
    // noindex. This is the parity case the PR #183 review (MAJOR 1) flagged as missing here.
    const consortium = makeRecord({
      bidder: {
        slug: 'bidder-consortium',
        orderingUnit: null,
        name: 'ЕТ Иван Петров; Строй ООД',
        displayName: 'ЕТ Иван Петров и др.',
        kind: 'consortium',
        typeLabel: null,
        settlement: 'Sofia',
        eik: '200000000',
        sector: null,
        totalContracts: 3,
        totalEur: 5000,
      },
      sourceNames: {
        authority: 'Some Authority',
        bidder: 'ЕТ Иван Петров; Строй ООД',
      },
    });
    consortium.bidder_legal_form = null; // name-based heuristic is what would otherwise match

    const masked = maskContractForPrivacy(consortium, consortium.bidder_legal_form);
    // Reference equality = not masked → caller will NOT set the noindex marker.
    expect(masked).toBe(consortium);
    expect(masked.bidder.eik).toBe('200000000');
    expect(masked.bidder.name).toBe('ЕТ Иван Петров; Строй ООД');
    expect(masked.bidder.displayName).toBe('ЕТ Иван Петров и др.');
    expect(masked.sourceNames.bidder).toBe('ЕТ Иван Петров; Строй ООД');
  });

  it('does NOT mask a consortium whose legal_form matches a sole-trader form (kind=consortium guard)', () => {
    // Belt-and-braces: even when `legal_form` is literally "ЕТ", a consortium must be exempt — the
    // `kind` signal is authoritative over the name/legal_form heuristic for JV entities.
    const consortium = makeRecord({
      bidder: {
        slug: 'bidder-consortium',
        orderingUnit: null,
        name: 'ЕТ Петров; ВИСТА ООД',
        displayName: 'ЕТ Петров и др.',
        kind: 'consortium',
        typeLabel: null,
        settlement: null,
        eik: '200000001',
        sector: null,
        totalContracts: 2,
        totalEur: 3000,
      },
      sourceNames: {
        authority: 'Some Authority',
        bidder: 'ЕТ Петров; ВИСТА ООД',
      },
    });
    consortium.bidder_legal_form = 'ЕТ';

    const masked = maskContractForPrivacy(consortium, consortium.bidder_legal_form);
    expect(masked).toBe(consortium);
    expect(masked.bidder.eik).toBe('200000001');
  });
});

describe('contract.json loader', () => {
  beforeEach(() => {
    vi.mocked(getContract).mockReset();
  });

  it('masks a sole trader, stamps the privacy marker, and lets the worker translate it to noindex (behavior 1)', async () => {
    vi.mocked(getContract).mockResolvedValueOnce(makeRecord());

    const response = await loader(loaderArgs('c-1'));

    expect(response.status).toBe(200);
    // The route stamps the INTERNAL privacy-mask marker — the public `X-Robots-Tag: noindex`
    // header is the worker's job (ADR-0040). The loader never writes `X-Robots-Tag` itself
    // (ydimitrof review 2026-08-31, thread on apps/web/app/routes/contract.json.tsx:91).
    expect(response.headers.get('X-Privacy-Mask')).toBe('applied');
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const body = (await response.json()) as {
      bidder: { eik: string | null; name: string; displayName: string };
      sourceNames: { bidder: string };
    };
    expect(body.bidder.eik).toBeNull();
    expect(body.bidder.name).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(body.bidder.displayName).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(body.sourceNames.bidder).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(body.bidder.name).not.toBe('ЕТ ДРИФТ - НИКОЛАЙ КИРОВ');
    expect(body.sourceNames.bidder).not.toBe('ЕТ ДРИФТ - НИКОЛАЙ КИРОВ');
  });

  it('does NOT leak the server-only bidder_legal_form field into the masked body (PR #183 review #2)', async () => {
    // The record carries `bidder_legal_form` as a server-only input to the masker; the public
    // ContractRecord API contract does not include the field, so the JSON response body must not
    // either. Without the explicit destructure, the spread `...record` in the masker's masked
    // branch preserved the extra field — a public payload that advertised the natural-person
    // classification alongside the masked name.
    vi.mocked(getContract).mockResolvedValueOnce(makeRecord());
    const response = await loader(loaderArgs('c-1'));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('bidder_legal_form');
  });

  it('does NOT leak the server-only bidder_legal_form field into a passthrough legal-entity body (PR #183 review #2)', async () => {
    // Same invariant on the no-mask branch — when the masker returns the record by reference, the
    // extra field is still server-only and must not reach the client. This is the path the legal
    // entity / consortium negative cases take.
    const record = makeRecord({
      bidder: {
        slug: 'bidder-2',
        orderingUnit: null,
        name: 'СОФАРМА ТРЕЙДИНГ АД',
        displayName: 'СОФАРМА ТРЕЙДИНГ АД',
        kind: 'company',
        typeLabel: null,
        settlement: 'Sofia',
        eik: '123456789',
        sector: null,
        totalContracts: 1,
        totalEur: 1000,
      },
    });
    record.bidder_legal_form = 'АД';
    vi.mocked(getContract).mockResolvedValueOnce(record);

    const response = await loader(loaderArgs('c-2'));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('bidder_legal_form');
  });

  it('passes a legal entity through verbatim and omits the privacy mask marker (behavior 2)', async () => {
    const record = makeRecord({
      bidder: {
        slug: 'bidder-2',
        orderingUnit: null,
        name: 'СОФАРМА ТРЕЙДИНГ АД',
        displayName: 'СОФАРМА ТРЕЙДИНГ АД',
        kind: 'company',
        typeLabel: null,
        settlement: 'Sofia',
        eik: '123456789',
        sector: null,
        totalContracts: 1,
        totalEur: 1000,
      },
      sourceNames: {
        authority: 'Some Authority',
        bidder: 'СОФАРМА ТРЕЙДИНГ АД',
      },
    });
    record.bidder_legal_form = 'АД';
    vi.mocked(getContract).mockResolvedValueOnce(record);

    const response = await loader(loaderArgs('c-2'));

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Privacy-Mask')).toBeNull();
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
    const body = (await response.json()) as {
      bidder: { eik: string | null; name: string };
      sourceNames: { bidder: string };
    };
    expect(body.bidder.eik).toBe('123456789');
    expect(body.bidder.name).toBe('СОФАРМА ТРЕЙДИНГ АД');
    expect(body.sourceNames.bidder).toBe('СОФАРМА ТРЕЙДИНГ АД');
  });

  it('returns the unchanged not_found body when getContract resolves null (behavior 3)', async () => {
    vi.mocked(getContract).mockResolvedValueOnce(null);

    const response = await loader(loaderArgs('c-999'));

    expect(response.status).toBe(404);
    expect(response.headers.get('X-Privacy-Mask')).toBeNull();
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
    const body = (await response.json()) as { error: string };
    expect(body).toEqual({ error: 'not_found' });
  });

  it('does NOT set the privacy marker for a consortium whose first member is a sole trader (behavior 5)', async () => {
    // Loader-level proof of the MAJOR 1 guard: reference-equality from maskContractForPrivacy must
    // propagate to the marker decision, so a consortium gets NO X-Privacy-Mask (→ no X-Robots-Tag).
    const consortium = makeRecord({
      bidder: {
        slug: 'bidder-consortium',
        orderingUnit: null,
        name: 'ЕТ Иван Петров; Строй ООД',
        displayName: 'ЕТ Иван Петров и др.',
        kind: 'consortium',
        typeLabel: null,
        settlement: 'Sofia',
        eik: '200000000',
        sector: null,
        totalContracts: 3,
        totalEur: 5000,
      },
      sourceNames: {
        authority: 'Some Authority',
        bidder: 'ЕТ Иван Петров; Строй ООД',
      },
    });
    consortium.bidder_legal_form = null;
    vi.mocked(getContract).mockResolvedValueOnce(consortium);

    const response = await loader(loaderArgs('c-consortium'));

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Privacy-Mask')).toBeNull();
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
    const body = (await response.json()) as { bidder: { eik: string | null; name: string } };
    expect(body.bidder.eik).toBe('200000000');
    expect(body.bidder.name).toBe('ЕТ Иван Петров; Строй ООД');
  });

  it('preserves the public, s-maxage=3600 Cache-Control policy on the success branch (behavior 4)', async () => {
    vi.mocked(getContract).mockResolvedValueOnce(makeRecord());
    const masked = await loader(loaderArgs('c-1'));
    expect(masked.headers.get('Cache-Control')).toBe(
      'public, s-maxage=3600, stale-while-revalidate=86400',
    );

    const legal = makeRecord({
      bidder: {
        slug: 'bidder-2',
        orderingUnit: null,
        name: 'СОФАРМА ТРЕЙДИНГ АД',
        displayName: 'СОФАРМА ТРЕЙДИНГ АД',
        kind: 'company',
        typeLabel: null,
        settlement: 'Sofia',
        eik: '123456789',
        sector: null,
        totalContracts: 1,
        totalEur: 1000,
      },
      sourceNames: {
        authority: 'Some Authority',
        bidder: 'СОФАРМА ТРЕЙДИНГ АД',
      },
    });
    legal.bidder_legal_form = 'АД';
    vi.mocked(getContract).mockResolvedValueOnce(legal);
    const unmasked = await loader(loaderArgs('c-2'));
    expect(unmasked.headers.get('Cache-Control')).toBe(
      'public, s-maxage=3600, stale-while-revalidate=86400',
    );
  });
});
