import { describe, expect, it } from 'vitest';
import {
  BASE_CONTRACT_COLS,
  baseSqlLiteral,
  mapBaseRecord,
  toEventDate,
  toISODate,
  toInt,
  toPeriodDate,
  toReal,
} from './base';

const FIXED_NOW = new Date('2026-06-11T12:00:00Z');

function utcDay(addDays = 0): string {
  const d = new Date(FIXED_NOW.getTime());
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + addDays);
  return d.toISOString().slice(0, 10);
}

describe('base EOP mapper', () => {
  it('maps the full contract staging column set and keeps register numbers as text', () => {
    const row = mapBaseRecord(
      'contracts',
      {
        contractNumber: 'C-1',
        publicationDate: '2026-06-01T12:34:56Z',
        buyerRegistryNumber: '001234567',
        supplierRegisterNumber: '000987654',
        contractValue: '1 234,56',
        offersCount: '3',
      },
      { day: '2026-06-01', fetchedAt: '2026-06-07T00:00:00Z' },
    );

    expect(row).not.toBeNull();
    expect(Object.keys(row ?? {})).toEqual(BASE_CONTRACT_COLS);
    expect(row?.source).toBe('eop:contracts:2026-06-01');
    expect(row?.published_at).toBe('2026-06-01');
    expect(row?.authority_eik).toBe('001234567');
    expect(row?.contractor_eik).toBe('000987654');
    expect(row?.signing_value).toBe(1234.56);
    expect(row?.bids_received).toBe(3);
  });

  it('applies tender-specific inverse and enum coercions', () => {
    const row = mapBaseRecord(
      'tenders',
      {
        publicationDate: '01.06.2026',
        hasUnsecuredFunding: 'да',
        hasVariants: 'Разрешено',
      },
      { day: '2026-06-01', fetchedAt: '2026-06-07T00:00:00Z' },
    );

    expect(row?.published_at).toBe('2026-06-01');
    expect(row?.secured_financing).toBe(0);
    expect(row?.variants).toBe(1);
  });

  it('nulls malformed, negative, and out-of-range coercions without throwing', () => {
    expect(toInt('-1')).toBeNull();
    expect(toInt('12abc')).toBeNull();
    expect(toReal('-0.01')).toBeNull();
    expect(toReal('Infinity')).toBeNull();
    expect(toReal('1 234,56')).toBe(1234.56);
    expect(toISODate('1989-12-31')).toBeNull();
    expect(toISODate('2026-02-31')).toBeNull();
    expect(toISODate('not a date')).toBeNull();
  });

  it('keeps plausible future dates within the generous sane-date ceiling', () => {
    expect(toISODate('14.05.2029', FIXED_NOW)).toBe('2029-05-14');
    expect(toISODate('2029-05-14', FIXED_NOW)).toBe('2029-05-14');
    expect(toISODate('14.05.2024', FIXED_NOW)).toBe('2024-05-14');
    expect(toISODate(utcDay(), FIXED_NOW)).toBe(utcDay());
    expect(toISODate(utcDay(2), FIXED_NOW)).toBe(utcDay(2));
    expect(toISODate(utcDay(30), FIXED_NOW)).toBe(utcDay(30));
    expect(toISODate('2027-01-15', FIXED_NOW)).toBe('2027-01-15');
    expect(toEventDate('2029-05-14', FIXED_NOW)).toBe('2029-05-14');
    expect(toPeriodDate('2029-05-14', FIXED_NOW)).toBe('2029-05-14');
    expect(toISODate('9999-01-01', FIXED_NOW)).toBeNull();
  });

  it('allows tender period dates through the far-future planning ceiling', () => {
    for (const year of [2028, 2029, 2035, 2043]) {
      const row = mapBaseRecord(
        'tenders',
        {
          publicationDate: '14.05.2024',
          tenderStartDate: '2025-01-01',
          tenderEndDate: `${year}-12-31`,
        },
        { day: '2026-06-01', fetchedAt: '2026-06-07T00:00:00Z' },
      );

      expect(row?.start_date).toBe('2025-01-01');
      expect(row?.end_date).toBe(`${year}-12-31`);
    }

    expect(toPeriodDate('31.02.2024', FIXED_NOW)).toBeNull();
    expect(toPeriodDate('9999-01-01', FIXED_NOW)).toBeNull();
    expect(toPeriodDate('2025-06-01', FIXED_NOW)).toBe('2025-06-01');
    expect(baseSqlLiteral('tenders', 'end_date', '2043-12-31')).toBe("'2043-12-31'");
  });
});
