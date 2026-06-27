import { describe, expect, it } from 'vitest';
import { CPV_SECTORS } from '@sigma/config';
import {
  companyListParams,
  getMulti,
  leaderboardRankOffset,
  MAX_MULTI_VALUES,
  pageNav,
} from './filters';

describe('getMulti', () => {
  it('caps repeated and CSV multi-value params', () => {
    const params = new URLSearchParams();
    params.set('kind', Array.from({ length: 100 }, (_, i) => `k${i}`).join(','));

    const values = getMulti(params, 'kind');

    expect(values).toHaveLength(MAX_MULTI_VALUES);
    expect(values.length).toBeLessThanOrEqual(50);
  });

  it('preserves outlier year values while capping floods', () => {
    const params = new URLSearchParams();
    params.set('year', ['2016', ...Array.from({ length: 100 }, (_, i) => `y${i}`)].join(','));

    const years = getMulti(params, 'year');

    expect(years).toContain('2016');
    expect(years).toHaveLength(MAX_MULTI_VALUES);
    expect(years.length).toBeLessThanOrEqual(50);
  });

  it('drops invalid oversized sector values before they reach SQL filters', () => {
    const params = new URLSearchParams();
    params.set('sector', Array.from({ length: 120 }, (_, i) => String(i + 1)).join(','));
    const sectors = getMulti(params, 'sector');

    expect(sectors.length).toBeLessThanOrEqual(MAX_MULTI_VALUES);
    expect(sectors.every((sector) => CPV_SECTORS.some((known) => known.code === sector))).toBe(
      true,
    );
  });

  it('keeps only known sectors and preserves years in shared company params', () => {
    const params = new URLSearchParams();
    const knownSector = CPV_SECTORS[0]!.code;
    params.set('sector', `${knownSector},99`);
    params.set('year', '2024,2016,unknown');
    params.set('eu', 'eu');

    expect(companyListParams(params)).toMatchObject({
      sectors: [knownSector],
      years: ['2024', '2016', 'unknown'],
      eu: 'eu',
    });
  });
});

describe('leaderboardRankOffset', () => {
  it('continues rank numbering across paged keyset results', () => {
    expect(leaderboardRankOffset(1, 25)).toBe(0);
    expect(leaderboardRankOffset(2, 25)).toBe(25);
    expect(leaderboardRankOffset(3, 15)).toBe(30);
  });
});

describe('pageNav', () => {
  const sp = (qs: string) => new URLSearchParams(qs);

  it('forces page 1 and offers Next when there is no cursor', () => {
    const nav = pageNav({ base: sp(''), total: 100, pageSize: 25, nextCursor: 'c2', prevCursor: null });
    expect(nav.page).toBe(1);
    expect(nav.pageCount).toBe(4);
    expect(nav.prevHref).toBeNull();
    expect(nav.nextHref).toContain('page=2');
  });

  it('keeps Next enabled mid-list and advances both cursor and page marker', () => {
    const nav = pageNav({
      base: sp('cursor=c2&page=2'),
      total: 100,
      pageSize: 25,
      nextCursor: 'c3',
      prevCursor: 'c1',
    });
    expect(nav.page).toBe(2);
    expect(nav.nextHref).toContain('page=3');
    expect(nav.prevHref).toContain('page=1');
  });

  it('disables Next on the displayed last page even while a cursor remains (#87)', () => {
    // A stale/forged ?page beyond pageCount clamps to pageCount; Next must not keep walking past it
    // with a frozen „N от M" / rank. Before the fix nextHref was non-null here.
    const nav = pageNav({
      base: sp('cursor=c4&page=9'),
      total: 100,
      pageSize: 25,
      nextCursor: 'c5',
      prevCursor: 'c3',
    });
    expect(nav.pageCount).toBe(4);
    expect(nav.page).toBe(4); // clamped to pageCount
    expect(nav.nextHref).toBeNull();
    expect(nav.prevHref).not.toBeNull();
  });

  it('disables Next at the true end when the cursor is exhausted', () => {
    const nav = pageNav({
      base: sp('cursor=c4&page=4'),
      total: 100,
      pageSize: 25,
      nextCursor: null,
      prevCursor: 'c3',
    });
    expect(nav.nextHref).toBeNull();
  });
});
