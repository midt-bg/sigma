import { afterEach, describe, expect, it, vi } from 'vitest';

// Loader + pure-helper tests for /overruns. @sigma/db is mocked so the loader runs without a real D1 —
// the query functions are the trust boundary the loader sits on top of (same pattern as
// conflicts.loaders.test.ts). Pure inspector-field helpers are tested directly against real
// OverrunRow shapes so the „ДЕТАЙЛИ ПО ДОГОВОРА" grid never silently drops or fabricates a field.
const q = vi.hoisted(() => ({
  getOverrunsAnalytics: vi.fn(),
  getOverrunAnnexes: vi.fn(),
  getDb: vi.fn((env: { DB: unknown }) => env.DB),
}));
vi.mock('@sigma/db', () => q);

import { cpvText, financingText, inspectorFields, loader, termText } from './overruns';

const DB = {};
const context = { cloudflare: { env: { DB } } };
const call = (searchParams: string) =>
  loader({
    request: new Request(`https://sigma.local/overruns${searchParams}`),
    context,
  } as never);

afterEach(() => {
  for (const fn of Object.values(q)) fn.mockReset();
});

const BASE_ROW = {
  contractId: 'c1',
  contractSlug: 'c1-slug',
  subject: 'Договор за строеж',
  authorityName: 'Община Х',
  authoritySlug: 'obshtina-h',
  authorityEik: '000000000',
  bidderName: 'Фирма ООД',
  bidderSlug: 'firma-ood',
  bidderEik: '111111111',
  signingEur: 1000,
  currentEur: 1500,
  deltaEur: 500,
  pct: 50,
  annexCount: 2,
  sectorLabel: 'Строителство',
  cpvCode: '45233110',
  cpvDescription: 'Строеж на магистрали',
  procedureType: 'Открита процедура',
  euFunded: true,
  euProgramme: 'ОПРР',
  signedAt: '2020-01-01',
  endDate: '2021-01-01',
  durationDays: 365,
};

describe('loader (/overruns)', () => {
  it('defaults to the absolute-growth lens and groups annexes per contract', async () => {
    q.getOverrunsAnalytics.mockResolvedValue({ rows: [BASE_ROW], totalOverrunEur: 500, count: 1 });
    q.getOverrunAnnexes.mockResolvedValue([
      { contractId: 'c1', date: '2020-06-01', reason: 'обем', deltaEur: 200 },
      { contractId: 'c1', date: '2020-09-01', reason: 'срок', deltaEur: 300 },
    ]);

    const res = await call('');

    expect(q.getOverrunsAnalytics).toHaveBeenCalledWith(DB, { by: 'absolute' });
    expect(q.getOverrunAnnexes).toHaveBeenCalledWith(DB, ['c1']);
    expect(res.by).toBe('absolute');
    expect(res.data.rows).toHaveLength(1);
    expect(res.annexesByContract.c1).toEqual([
      { seq: 1, date: '2020-06-01', reason: 'обем', deltaEur: 200 },
      { seq: 2, date: '2020-09-01', reason: 'срок', deltaEur: 300 },
    ]);
  });

  it('switches to the percent lens only on the exact opt-in value', async () => {
    q.getOverrunsAnalytics.mockResolvedValue({ rows: [], totalOverrunEur: 0, count: 0 });
    q.getOverrunAnnexes.mockResolvedValue([]);

    const res = await call('?by=percent');

    expect(q.getOverrunsAnalytics).toHaveBeenCalledWith(DB, { by: 'percent' });
    expect(res.by).toBe('percent');
  });

  it('falls back to absolute for an unrecognised ?by value', async () => {
    q.getOverrunsAnalytics.mockResolvedValue({ rows: [], totalOverrunEur: 0, count: 0 });
    q.getOverrunAnnexes.mockResolvedValue([]);

    const res = await call('?by=bogus');

    expect(res.by).toBe('absolute');
  });
});

describe('financingText', () => {
  it('labels EU-funded contracts with the programme when known', () => {
    expect(financingText({ ...BASE_ROW, euFunded: true, euProgramme: 'ОПРР' })).toBe(
      'Европейско · ОПРР',
    );
  });

  it('labels EU-funded contracts without a known programme', () => {
    expect(financingText({ ...BASE_ROW, euFunded: true, euProgramme: null })).toBe('Европейско');
  });

  it('labels national funding', () => {
    expect(financingText({ ...BASE_ROW, euFunded: false })).toBe('Национално');
  });

  it('never fabricates a funding source when unknown', () => {
    expect(financingText({ ...BASE_ROW, euFunded: null })).toBe('—');
  });
});

describe('cpvText', () => {
  it('joins code and description when both are present', () => {
    expect(cpvText({ ...BASE_ROW, cpvCode: '45233110', cpvDescription: 'Строеж' })).toBe(
      '45233110 — Строеж',
    );
  });

  it('falls back to the bare code without a description', () => {
    expect(cpvText({ ...BASE_ROW, cpvCode: '45233110', cpvDescription: null })).toBe('45233110');
  });

  it('never fabricates a CPV code when absent', () => {
    expect(cpvText({ ...BASE_ROW, cpvCode: null })).toBe('—');
  });
});

describe('termText', () => {
  it('prefers the real end date', () => {
    expect(termText({ ...BASE_ROW, endDate: '2021-01-01', durationDays: 365 })).toContain('2021');
  });

  it('falls back to duration in days without an end date', () => {
    expect(termText({ ...BASE_ROW, endDate: null, durationDays: 90 })).toBe('90 дни');
  });

  it('returns null (omitted, never fabricated) when neither is on record', () => {
    expect(termText({ ...BASE_ROW, endDate: null, durationDays: null })).toBeNull();
  });
});

describe('inspectorFields', () => {
  it('includes the Срок row only when a real term value exists', () => {
    const withTerm = inspectorFields({ ...BASE_ROW, endDate: '2021-01-01', durationDays: null });
    expect(withTerm.some((f) => f.k === 'Срок')).toBe(true);

    const withoutTerm = inspectorFields({ ...BASE_ROW, endDate: null, durationDays: null });
    expect(withoutTerm.some((f) => f.k === 'Срок')).toBe(false);
  });

  it('falls back to непотвърден for a bidder without a valid ЕИК', () => {
    const fields = inspectorFields({ ...BASE_ROW, bidderEik: null });
    const executor = fields.find((f) => f.k === 'Изпълнител · ЕИК');
    expect(executor?.v).toContain('непотвърден');
  });
});
