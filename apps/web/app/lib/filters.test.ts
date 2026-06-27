import { describe, expect, it } from 'vitest';
import { CPV_SECTORS } from '@sigma/config';
import {
  companyListParams,
  contractListParams,
  getMulti,
  leaderboardRankOffset,
  MAX_MULTI_VALUES,
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

describe('contractListParams', () => {
  it('parses the bids single-offer flag so the page and CSV filter identically (#138)', () => {
    expect(contractListParams(new URLSearchParams('bids=1')).bids).toBe('one');
    expect(contractListParams(new URLSearchParams('')).bids).toBeNull();
    expect(contractListParams(new URLSearchParams('bids=2')).bids).toBeNull();
  });

  it('carries the full contract filter set shared by /contracts and /contracts.csv', () => {
    const knownSector = CPV_SECTORS[0]!.code;
    const sp = new URLSearchParams();
    sp.set('sector', `${knownSector},99`);
    sp.set('year', '2024');
    sp.set('procedure', 'open');
    sp.set('value', 'gt100m');
    sp.set('eu', 'eu');
    sp.set('authority', '123456789');
    sp.set('bidder', 'acme');
    sp.set('q', 'rail');
    sp.set('bids', '1');

    expect(contractListParams(sp)).toMatchObject({
      sectors: [knownSector],
      years: ['2024'],
      procedureGroups: ['open'],
      valueBucket: 'gt100m',
      eu: 'eu',
      authority: '123456789',
      bidder: 'acme',
      q: 'rail',
      bids: 'one',
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
