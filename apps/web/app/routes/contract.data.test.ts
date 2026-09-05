import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractRecord } from '@sigma/api-contract';
import { applyPrivacyMaskHeaders } from '../lib/security';
import { getContract } from '@sigma/db';
import { headers, loader } from './contract';

vi.mock('@sigma/db', () => ({
  getContract: vi.fn(),
  getDb: (env: unknown) => (env as { DB: unknown }).DB,
  contractIdFromSlug: (slug: string) => 'c:' + slug,
}));

// Minimal ContractRecord builder. The loader only reads `bidder.{name,displayName,kind,eik}` and
// `bidder_legal_form`, so the rest is inert fixture mass (kept small to stay readable).
function makeRecord(overrides: Partial<ContractRecord> = {}): ContractRecord & {
  bidder_legal_form: string | null;
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
    sourceNames: { authority: 'Some Authority', bidder: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ' },
    bidder_legal_form: 'ЕТ',
    ...overrides,
  };
}

function loaderArgs(id: string): Parameters<typeof loader>[0] {
  return {
    params: { id },
    context: { cloudflare: { env: { DB: {} as never } } },
  } as unknown as Parameters<typeof loader>[0];
}

beforeEach(() => {
  vi.mocked(getContract).mockReset();
});

// MAJOR 2 (PR #183 review): the contract detail page (`/contracts/:id`) and its RRv7 single-fetch
// `.data` twin share ONE loader, so masking + signalling in the loader covers BOTH the rendered HTML
// and the machine-readable `.data` payload. This is the most-indexable surface (robots.txt does not
// block /contracts/:id or its .data twin), so a sole-trader ЕИК leaked here is a worse exposure than
// the already-closed .json/.csv paths. The policy mirrors `company.tsx:89` exactly: ЕИК (the
// sensitive natural-person ID) → null, the trading displayName stays PUBLIC (ADR-0039 §6), and the
// `X-Privacy-Mask: applied` marker is set so the worker translates it to `X-Robots-Tag: noindex`.
describe('contract.data loader — natural-person bidder branch', () => {
  it('clears the sole-trader ЕИК and marks the response noindex (covers HTML + .data twin)', async () => {
    const natural = makeRecord();
    vi.mocked(getContract).mockResolvedValueOnce(natural);

    const result = await loader(loaderArgs('c-1'));

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Privacy-Mask')).toBe('applied');
    // The loader must NOT emit X-Robots-Tag directly — that is the worker's job (ADR-0040).
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
    const body = (await response.json()) as { contract: { bidder: { eik: string | null } } };
    // ЕИК is the sensitive natural-person identifier → masked on the shared object.
    expect(body.contract.bidder.eik).toBeNull();
  });

  it('keeps the consortium ЕИК and sets no marker (kind=consortium guard, parity with JSON masker)', async () => {
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
      sourceNames: { authority: 'Some Authority', bidder: 'ЕТ Иван Петров; Строй ООД' },
    });
    consortium.bidder_legal_form = null;
    vi.mocked(getContract).mockResolvedValueOnce(consortium);

    const result = await loader(loaderArgs('c-consortium'));

    // Plain object return = no marker, no masking. A consortium is never over-masked/noindexed.
    expect(result).not.toBeInstanceOf(Response);
    const plain = result as { contract: ContractRecord };
    expect(plain.contract.bidder.eik).toBe('200000000');
  });
});

describe('contract.data loader — legal-entity bidder branch', () => {
  it('returns a plain object (not a Response) with the ЕИК unchanged and no marker', async () => {
    const legal = makeRecord({
      bidder: {
        slug: 'bidder-2',
        orderingUnit: null,
        name: 'СОФАРМА ТРЕЙДИНГ АД',
        displayName: 'СОФАРМА ТРЕЙДИНГ АД',
        kind: 'company',
        typeLabel: null,
        settlement: 'Sofia',
        eik: '121817309',
        sector: null,
        totalContracts: 1,
        totalEur: 1000,
      },
      sourceNames: { authority: 'Some Authority', bidder: 'СОФАРМА ТРЕЙДИНГ АД' },
    });
    legal.bidder_legal_form = 'АД';
    vi.mocked(getContract).mockResolvedValueOnce(legal);

    const result = await loader(loaderArgs('c-2'));

    expect(result).not.toBeInstanceOf(Response);
    const plain = result as { contract: ContractRecord };
    expect(plain.contract.bidder.eik).toBe('121817309');
  });
});

// The `headers()` export forwards the loader-set marker onto the HTML response so the worker's
// `hardenResponse` can translate it. React Router's `getDocumentHeadersImpl` does not auto-propagate
// loader headers (only Set-Cookie), so the route must forward explicitly — same shape as company.tsx.
describe('contract.data headers() — forwards the privacy mask marker', () => {
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

// Server-only `bidder_legal_form` must NOT leak into the `.data` RRv7 single-fetch payload on
// either the masked branch or the legal-entity / consortium passthrough branch (parity with
// `contract.json.tsx`'s `stripServerOnlyFields`). The contract page loader is the OTHER
// surface that ships the full ContractDetail in the single-fetch body — without the strip, the
// natural-person classifier leaks verbatim to the client (ydimitrof review 2026-08-31, thread on
// apps/web/app/routes/contract.tsx:139).
describe('contract.data loader — strips the server-only bidder_legal_form field on every branch', () => {
  it('does NOT carry bid_legal_form into the masked Response body', async () => {
    const natural = makeRecord(); // bidder_legal_form = 'ЕТ' (sole trader)
    vi.mocked(getContract).mockResolvedValueOnce(natural);

    const result = await loader(loaderArgs('c-1'));
    expect(result).toBeInstanceOf(Response);
    const body = ((result as Response).clone ? await (result as Response).clone().json() : await (result as Response).json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty('bidder_legal_form');
    const contract = body.contract as Record<string, unknown>;
    expect(contract).not.toHaveProperty('bidder_legal_form');
  });

  it('does NOT carry bid_legal_form into the legal-entity passthrough body', async () => {
    const legal = makeRecord({
      bidder: {
        slug: 'bidder-legal',
        orderingUnit: null,
        name: 'СОФАРМА ТРЕЙДИНГ АД',
        displayName: 'СОФАРМА ТРЕЙДИНГ АД',
        kind: 'company',
        typeLabel: null,
        settlement: 'Sofia',
        eik: '121817309',
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

    const result = await loader(loaderArgs('c-2'));
    expect(result).not.toBeInstanceOf(Response);
    const plain = result as { contract: Record<string, unknown> };

    expect(plain.contract).not.toHaveProperty('bidder_legal_form');
  });
});

// Worker-pipeline proof: the marker the loader sets must translate to X-Robots-Tag: noindex through
// the real `applyPrivacyMaskHeaders` (the worker helper) and the marker must be stripped. This is the
// contract the noindex guarantee depends on for both the HTML page and the `.data` twin.
describe('contract.data worker pipeline — applyPrivacyMaskHeaders on the loader return', () => {
  it('translates X-Privacy-Mask: applied into X-Robots-Tag: noindex and removes the marker', async () => {
    const natural = makeRecord();
    vi.mocked(getContract).mockResolvedValueOnce(natural);

    const result = await loader(loaderArgs('c-1'));
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;

    applyPrivacyMaskHeaders(response.headers);

    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(response.headers.has('X-Privacy-Mask')).toBe(false);
  });
});
