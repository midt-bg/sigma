import { describe, expect, it } from 'vitest';
import { CPV_SECTORS } from '@sigma/config';
import {
  authorityListFilters,
  companyListParams,
  contractListFilters,
  getMulti,
  leaderboardRankOffset,
  MAX_MULTI_VALUES,
} from './filters';

describe('contractListFilters', () => {
  it('parses the bids filter the HTML list and CSV export must share (issue #138)', () => {
    const sp = new URLSearchParams('bids=1&year=2025&authority=123');
    const f = contractListFilters(sp);
    expect(f.bids).toBe('one');
    expect(f.years).toEqual(['2025']);
    expect(f.authority).toBe('123');
  });

  it('leaves bids null when the param is absent or not "1"', () => {
    expect(contractListFilters(new URLSearchParams('')).bids).toBeNull();
    expect(contractListFilters(new URLSearchParams('bids=two')).bids).toBeNull();
  });

  it('normalises an unknown sort to the default rather than passing it through', () => {
    expect(contractListFilters(new URLSearchParams('sort=bogus')).sort).toBe('value-desc');
  });
});

describe('authorityListFilters', () => {
  it('parses the same filter set the HTML list and CSV export must share (#138)', () => {
    const f = authorityListFilters(
      new URLSearchParams('type=municipality&sector=45&year=2025&eu=eu&q=път'),
    );
    expect(f).toMatchObject({
      types: ['municipality'],
      sectors: ['45'],
      years: ['2025'],
      eu: 'eu',
      q: 'път',
    });
  });
});

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
