import { describe, expect, it } from 'vitest';
import { CPV_SECTORS } from '@sigma/config';
import {
  companyListParams,
  cpvGroupSelection,
  getMulti,
  leaderboardRankOffset,
  MAX_CPV_GROUP_SELECTION,
  MAX_MULTI_VALUES,
} from './filters';

const sp = (q: string) => new URLSearchParams(q);

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

describe('cpvGroupSelection', () => {
  it('parses repeatable and CSV ?cpv values into a deduped, order-preserving set', () => {
    expect(cpvGroupSelection(sp('cpv=45233&cpv=33600'))).toEqual(['45233', '33600']);
    expect(cpvGroupSelection(sp('cpv=45233,33600'))).toEqual(['45233', '33600']);
    expect(cpvGroupSelection(sp('cpv=45233&cpv=45233&cpv=33600'))).toEqual(['45233', '33600']);
    expect(cpvGroupSelection(sp(''))).toEqual([]);
  });

  it('drops anything that is not exactly a 5-digit group code (CWE-349 key hygiene)', () => {
    expect(
      cpvGroupSelection(sp('cpv=4523&cpv=452333&cpv=abcde&cpv=45 33&cpv= 45233 &cpv=%27--')),
    ).toEqual(['45233']);
  });

  it('caps the selection at MAX_CPV_GROUP_SELECTION so hostile spam stays bounded', () => {
    const q = Array.from({ length: 40 }, (_, i) => `cpv=${10000 + i}`).join('&');
    const out = cpvGroupSelection(sp(q));
    expect(out).toHaveLength(MAX_CPV_GROUP_SELECTION);
    expect(out[0]).toBe('10000');
    expect(out.at(-1)).toBe(String(10000 + MAX_CPV_GROUP_SELECTION - 1));
  });
});

describe('leaderboardRankOffset', () => {
  it('continues rank numbering across paged keyset results', () => {
    expect(leaderboardRankOffset(1, 25)).toBe(0);
    expect(leaderboardRankOffset(2, 25)).toBe(25);
    expect(leaderboardRankOffset(3, 15)).toBe(30);
  });
});
