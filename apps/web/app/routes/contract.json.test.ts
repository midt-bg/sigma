import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractRecord } from '@sigma/api-contract';
import { MASKED_NATURAL_PERSON_LABEL } from '@sigma/shared';

vi.mock('@sigma/db', () => ({
  getContract: vi.fn(),
  contractIdFromSlug: (slug: string) => 'c:' + slug,
}));

import { getContract } from '@sigma/db';
import { loader, maskContractForPrivacy } from './contract.json';

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
    },
    frameworkAwards: null,
    authority: {
      slug: 'auth-1',
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
    sourceNames: {
      authority: 'Some Authority',
      bidder: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ',
    },
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

describe('maskContractForPrivacy', () => {
  it('masks bidder fields and returns a new object when legal_form identifies a sole trader', () => {
    const record = makeRecord();
    const masked = maskContractForPrivacy(record, record.bidder_legal_form);
    expect(masked).not.toBe(record);
    expect(masked.bidder.eik).toBeNull();
    expect(masked.bidder.name).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(masked.bidder.displayName).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(masked.sourceNames.bidder).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(masked.bidder.slug).toBe('bidder-1');
    expect(masked.bidder.totalEur).toBe(1000);
  });

  it('returns the input by reference when the bidder is a legal entity', () => {
    const record = makeRecord({
      bidder: {
        slug: 'bidder-2',
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

  it('masks when legal_form is null but the name starts with the leading-ЕТ heuristic', () => {
    const record = makeRecord();
    record.bidder_legal_form = null;
    const masked = maskContractForPrivacy(record, null);
    expect(masked).not.toBe(record);
    expect(masked.bidder.eik).toBeNull();
    expect(masked.bidder.name).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(masked.sourceNames.bidder).toBe(MASKED_NATURAL_PERSON_LABEL);
  });
});

describe('contract.json loader', () => {
  beforeEach(() => {
    vi.mocked(getContract).mockReset();
  });

  it('masks a sole trader and sets X-Privacy-Mask: applied (behavior 1)', async () => {
    vi.mocked(getContract).mockResolvedValueOnce(makeRecord());

    const response = await loader(loaderArgs('c-1'));

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Privacy-Mask')).toBe('applied');
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
    const body = (await response.json()) as { bidder: { eik: string | null; name: string; displayName: string }; sourceNames: { bidder: string } };
    expect(body.bidder.eik).toBeNull();
    expect(body.bidder.name).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(body.bidder.displayName).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(body.sourceNames.bidder).toBe(MASKED_NATURAL_PERSON_LABEL);
    expect(body.bidder.name).not.toBe('ЕТ ДРИФТ - НИКОЛАЙ КИРОВ');
    expect(body.sourceNames.bidder).not.toBe('ЕТ ДРИФТ - НИКОЛАЙ КИРОВ');
  });

  it('passes a legal entity through verbatim and omits the privacy mask marker (behavior 2)', async () => {
    const record = makeRecord({
      bidder: {
        slug: 'bidder-2',
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
    const body = (await response.json()) as { bidder: { eik: string | null; name: string }; sourceNames: { bidder: string } };
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

  it('preserves the public, s-maxage=3600 Cache-Control policy on the success branch (behavior 4)', async () => {
    vi.mocked(getContract).mockResolvedValueOnce(makeRecord());
    const masked = await loader(loaderArgs('c-1'));
    expect(masked.headers.get('Cache-Control')).toBe(
      'public, s-maxage=3600, stale-while-revalidate=86400',
    );

    const legal = makeRecord({
      bidder: {
        slug: 'bidder-2',
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