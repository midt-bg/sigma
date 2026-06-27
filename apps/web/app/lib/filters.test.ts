import { describe, expect, it } from 'vitest';
import { CPV_SECTORS } from '@sigma/config';
import {
  companyListParams,
  getMulti,
  leaderboardRankOffset,
  MAX_MULTI_VALUES,
  searchHref,
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

describe('searchHref', () => {
  it('sets q and resets cursor/page while preserving filters and sort', () => {
    const sp = new URLSearchParams('sort=name&year=2024&cursor=abc&page=3&sector=45');
    const out = new URLSearchParams(searchHref(sp, 'mostove'));

    expect(out.get('q')).toBe('mostove');
    expect(out.get('sort')).toBe('name');
    expect(out.getAll('year')).toEqual(['2024']);
    expect(out.get('sector')).toBe('45');
    expect(out.has('cursor')).toBe(false);
    expect(out.has('page')).toBe(false);
  });

  it('drops q when the query is empty or whitespace-only', () => {
    const sp = new URLSearchParams('q=old&sort=won');
    expect(new URLSearchParams(searchHref(sp, '')).has('q')).toBe(false);
    expect(new URLSearchParams(searchHref(sp, '   ')).has('q')).toBe(false);
  });

  it('trims surrounding whitespace from q', () => {
    expect(new URLSearchParams(searchHref(new URLSearchParams(), '  foo  ')).get('q')).toBe('foo');
  });

  it('emits q first in canonical order', () => {
    expect(searchHref(new URLSearchParams('sort=name'), 'x')).toBe('?q=x&sort=name');
  });

  it('preserves repeated multi-value params', () => {
    const sp = new URLSearchParams();
    sp.append('year', '2024');
    sp.append('year', '2023');
    sp.set('sector', '45');

    expect(new URLSearchParams(searchHref(sp, 'q')).getAll('year')).toEqual(['2024', '2023']);
  });

  it('preserves unknown keys not in PARAM_ORDER (e.g. contracts bids)', () => {
    const sp = new URLSearchParams('bids=1&sort=value-desc');
    expect(new URLSearchParams(searchHref(sp, 'q')).get('bids')).toBe('1');
  });
});

describe('leaderboardRankOffset', () => {
  it('continues rank numbering across paged keyset results', () => {
    expect(leaderboardRankOffset(1, 25)).toBe(0);
    expect(leaderboardRankOffset(2, 25)).toBe(25);
    expect(leaderboardRankOffset(3, 15)).toBe(30);
  });
});
