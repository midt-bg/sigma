import { describe, expect, it } from 'vitest';
import {
  BASE_CONTRACT_COLS,
  MAX_PLAUSIBLE_VALUE,
  MAX_SQL_TEXT_LEN,
  assertWellFormedSqlLiteral,
  baseSqlLiteral,
  escapeSqlText,
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
    expect(toReal(MAX_PLAUSIBLE_VALUE + 1)).toBeNull();
    expect(toReal('1 234,56')).toBe(1234.56);
    expect(toReal(500000000)).toBe(500000000);
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

describe('offline SQL literal hardening', () => {
  it('doubles single quotes so injection-shaped input stays a single literal', () => {
    expect(escapeSqlText("O'Brien")).toBe("'O''Brien'");
    expect(escapeSqlText("'; DROP TABLE x;--")).toBe("'''; DROP TABLE x;--'");
    // A literal payload that would close the string then run SQL stays fully quoted.
    expect(escapeSqlText("x' OR '1'='1")).toBe("'x'' OR ''1''=''1'");
  });

  it('routes text columns through escapeSqlText via baseSqlLiteral', () => {
    expect(baseSqlLiteral('contracts', 'contractor_name', "O'Brien")).toBe("'O''Brien'");
    expect(baseSqlLiteral('contracts', 'procurement_subject', "'; DROP TABLE x;--")).toBe(
      "'''; DROP TABLE x;--'",
    );
  });

  it('strips NUL and every C0/C1 control char while preserving printable Unicode', () => {
    expect(escapeSqlText('a\x00b')).toBe("'ab'");
    // One char from each C0 boundary, DEL, and a C1 control — all removed.
    expect(escapeSqlText('\x01a\x1Fb\x7Fc\x9Fd')).toBe("'abcd'");
    // Tabs/newlines are C0 controls and are stripped, not preserved.
    expect(escapeSqlText('line1\n\tline2')).toBe("'line1line2'");
    // Cyrillic and other printable Unicode pass through untouched.
    expect(escapeSqlText('Държавна агенция — №42')).toBe("'Държавна агенция — №42'");
  });

  it('caps absurdly long input at MAX_SQL_TEXT_LEN and stays well-formed', () => {
    const huge = 'a'.repeat(MAX_SQL_TEXT_LEN + 5000);
    const literal = escapeSqlText(huge);
    // Inner length is exactly the cap (no quote escaping needed for plain 'a').
    expect(literal.length).toBe(MAX_SQL_TEXT_LEN + 2);
    expect(literal.startsWith("'")).toBe(true);
    expect(literal.endsWith("'")).toBe(true);
    // Truncation happens before escaping, so a trailing quote can't be split mid-pair.
    expect(() => assertWellFormedSqlLiteral(literal)).not.toThrow();
    const quoteHeavy = "'".repeat(MAX_SQL_TEXT_LEN + 10);
    expect(() => escapeSqlText(quoteHeavy)).not.toThrow();
  });

  it('drops a trailing lone high surrogate when truncation splits a pair', () => {
    // 💩 is a surrogate pair (2 code units) placed astride the cap; a code-unit slice would keep
    // only its high surrogate. Assert the lone surrogate is dropped — no U+FFFD, still well-formed.
    const literal = escapeSqlText('a'.repeat(MAX_SQL_TEXT_LEN - 1) + '💩');
    expect(literal).not.toContain('�');
    expect(/[\uD800-\uDBFF]'$/.test(literal)).toBe(false);
    expect(() => assertWellFormedSqlLiteral(literal)).not.toThrow();
  });

  it('asserts a well-formed quoted literal and rejects malformed ones', () => {
    expect(() => assertWellFormedSqlLiteral("'ok'")).not.toThrow();
    expect(() => assertWellFormedSqlLiteral("'O''Brien'")).not.toThrow();
    expect(() => assertWellFormedSqlLiteral("''")).not.toThrow();
    expect(() => assertWellFormedSqlLiteral('no-quotes')).toThrow();
    expect(() => assertWellFormedSqlLiteral("'unterminated")).toThrow();
    // An odd-run (unescaped) interior single quote must be rejected.
    expect(() => assertWellFormedSqlLiteral("'a'b'")).toThrow();
  });
});
