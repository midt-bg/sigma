import { describe, expect, it } from 'vitest';
import { fakeD1 } from '@sigma/test-support';
import {
  FALLBACK_END_YEAR,
  START_YEAR,
  coverageEndYear,
  coveragePartialNote,
  coverageRange,
  getCoverageMeta,
  yearOptions,
} from './coverage';

describe('coverage labels', () => {
  it('uses the year from a valid as-of date and falls back for missing or malformed dates', () => {
    expect(coverageEndYear('2024-09-30')).toBe(2024);
    expect(coverageEndYear(null)).toBe(FALLBACK_END_YEAR);
    expect(coverageEndYear(undefined)).toBe(FALLBACK_END_YEAR);
    expect(coverageEndYear('year-09-30')).toBe(FALLBACK_END_YEAR);
  });

  it('formats the full and partial ranges with a fallback end year', () => {
    expect(coverageRange(2024)).toBe(`${START_YEAR}–2024`);
    expect(coverageRange(null)).toBe(`${START_YEAR}–${FALLBACK_END_YEAR}`);
    expect(coveragePartialNote(2025)).toBe(`${START_YEAR}–2025 (2025 г. частично)`);
    expect(coveragePartialNote(undefined)).toBe(
      `${START_YEAR}–${FALLBACK_END_YEAR} (${FALLBACK_END_YEAR} г. частично)`,
    );
  });

  it('lists years newest first and returns no option before the start year', () => {
    expect(yearOptions(2023)).toEqual(['2023', '2022', '2021', '2020']);
    expect(yearOptions(null)[0]).toBe(String(FALLBACK_END_YEAR));
    expect(yearOptions(START_YEAR - 1)).toEqual([]);
  });
});

describe('getCoverageMeta', () => {
  // The binding comes from the shared double: a cast to D1Database outside packages/test-support is
  // what `pnpm check:fake-d1` forbids (#325).
  const dbReturning = (row: object | null) => fakeD1([{ when: 'FROM home_totals', first: row }]);

  it('reads the singleton metadata row and derives its end year', async () => {
    const { db, sql } = dbReturning({
      as_of: '2025-12-15',
      refreshed_at: '2026-01-02T03:04:05Z',
    });

    await expect(getCoverageMeta(db)).resolves.toEqual({
      asOf: '2025-12-15',
      refreshedAt: '2026-01-02T03:04:05Z',
      coverageEndYear: 2025,
    });
    expect(sql).toEqual(['SELECT as_of, refreshed_at FROM home_totals WHERE id = 1']);
  });

  it('uses null metadata and the fallback year when the singleton row is absent', async () => {
    const { db } = dbReturning(null);
    await expect(getCoverageMeta(db)).resolves.toEqual({
      asOf: null,
      refreshedAt: null,
      coverageEndYear: FALLBACK_END_YEAR,
    });
  });
});
