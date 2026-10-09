import { describe, expect, it } from 'vitest';
import { fakeD1, throwingD1 } from '@sigma/test-support';
import { getPartialStartYear, partialStartYearOf } from './partial-years';

// The shape of the national year facet: a ramp-up first year, then full years, plus the stray rows a
// mistyped signing date leaves (an earlier year, a far future one, 'unknown').
const RAMP = [
  { key: '2016', contracts: 1 },
  { key: '2020', contracts: 5000 },
  { key: '2021', contracts: 26000 },
  { key: '2022', contracts: 31000 },
  { key: '2029', contracts: 1 },
  { key: 'unknown', contracts: 30 },
];

describe('partialStartYearOf', () => {
  it('marks the first year of the window partial when it has under half the next year', () => {
    expect(partialStartYearOf(RAMP)).toBe('2020');
  });

  it('leaves a full first year alone', () => {
    expect(
      partialStartYearOf([
        { key: '2020', contracts: 20000 },
        { key: '2021', contracts: 26000 },
      ]),
    ).toBeNull();
  });

  it('ignores stray years before the window and keys that are not years', () => {
    expect(
      partialStartYearOf([
        { key: '2019', contracts: 1 },
        { key: 'unknown', contracts: 9 },
        { key: '2020', contracts: 100 },
        { key: '2021', contracts: 1000 },
      ]),
    ).toBe('2020');
  });

  it('needs the year after the first one to judge it', () => {
    expect(partialStartYearOf([{ key: '2020', contracts: 5 }])).toBeNull();
    expect(
      partialStartYearOf([
        { key: '2020', contracts: 5 },
        { key: '2022', contracts: 500 },
      ]),
    ).toBeNull();
    expect(partialStartYearOf([])).toBeNull();
  });

  it('honours another window start', () => {
    expect(partialStartYearOf(RAMP, '2021')).toBeNull();
  });
});

describe('getPartialStartYear', () => {
  it('reads the national year facet', async () => {
    const { db, sql } = fakeD1([{ when: "facet = 'year'", all: RAMP }]);
    expect(await getPartialStartYear(db)).toBe('2020');
    expect(sql).toEqual([`SELECT key, contracts FROM facet_counts WHERE facet = 'year'`]);
  });

  it('answers null before the refresh has built the facet table', async () => {
    const { db } = throwingD1(new Error('D1_ERROR: no such table: facet_counts: SQLITE_ERROR'));
    expect(await getPartialStartYear(db)).toBeNull();
  });

  it('does not hide any other database failure', async () => {
    const { db } = throwingD1(new Error('D1_ERROR: D1 DB is overloaded'));
    await expect(getPartialStartYear(db)).rejects.toThrow('overloaded');
  });
});
