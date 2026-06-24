import { describe, expect, it } from 'vitest';
import { getRegionalSpending } from './regions';

// Fake D1 keyed by SQL markers (same approach as competition.test.ts). Verifies the JS-side
// aggregation: region name -> NUTS3 mapping, the always-28 zero-fill, the unattributed bucket,
// coverage, the NUTS2 macro rollup, and that a filter switches from the authority_totals rollup to
// base aggregation.

const ROWS = [
  { region: 'Пловдив', value_eur: 5000, contracts: 50, authorities: 10 },
  { region: 'Бургас', value_eur: 3000, contracts: 30, authorities: 6 },
  { region: 'Несъществуваща област', value_eur: 100, contracts: 1, authorities: 1 }, // unknown -> unattributed
  { region: null, value_eur: 2000, contracts: 20, authorities: 8 }, // NULL -> unattributed
];

function fakeDb(capture?: string[]): D1Database {
  return {
    prepare(sql: string) {
      capture?.push(sql);
      return {
        bind() {
          return this;
        },
        async all<T>() {
          return { results: ROWS as T[] };
        },
      };
    },
  } as unknown as D1Database;
}

describe('getRegionalSpending', () => {
  it('returns all 28 regions, sorted by value, with the top mapped to its NUTS3', async () => {
    const { regions } = await getRegionalSpending(fakeDb(), {});
    expect(regions).toHaveLength(28);
    expect(regions[0]).toMatchObject({ name: 'Пловдив', nuts3: 'BG421', valueEur: 5000 });
    expect(regions[1]).toMatchObject({ name: 'Бургас', nuts3: 'BG341', valueEur: 3000 });
    // a region with no rows is present and zero-filled
    expect(regions.find((r) => r.nuts3 === 'BG311')).toMatchObject({ name: 'Видин', valueEur: 0 });
  });

  it('folds NULL and unknown regions into the unattributed bucket', async () => {
    const { unattributed } = await getRegionalSpending(fakeDb(), {});
    expect(unattributed).toEqual({ valueEur: 2100, contracts: 21, authorities: 9 });
  });

  it('reports coverage as the share of authorities with a known region', async () => {
    const { coverage } = await getRegionalSpending(fakeDb(), {});
    expect(coverage.withRegion).toBe(16); // 10 + 6
    expect(coverage.total).toBe(25); // 16 + 9 unattributed
    expect(coverage.pct).toBeCloseTo(16 / 25);
  });

  it('rolls regions up into NUTS2 macro-regions', async () => {
    const { macroRegions } = await getRegionalSpending(fakeDb(), {});
    expect(macroRegions[0]).toMatchObject({
      nuts2: 'BG42',
      name: 'Южен централен',
      valueEur: 5000,
    });
    expect(macroRegions.find((m) => m.nuts2 === 'BG34')).toMatchObject({ valueEur: 3000 });
  });

  it('reads authority_totals unfiltered, but aggregates from base tables when filtered', async () => {
    const unfiltered: string[] = [];
    await getRegionalSpending(fakeDb(unfiltered), {});
    expect(unfiltered.some((s) => s.includes('FROM authority_totals'))).toBe(true);

    const filtered: string[] = [];
    await getRegionalSpending(fakeDb(filtered), { sector: '45' });
    expect(filtered.some((s) => s.includes('FROM authority_totals'))).toBe(false);
    expect(filtered.some((s) => s.includes('JOIN tenders t'))).toBe(true);
  });
});
