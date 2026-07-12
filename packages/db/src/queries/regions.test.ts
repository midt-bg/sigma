import { describe, expect, it } from 'vitest';
import { getRegionalSpending, getRegionTopBeneficiaries } from './regions';

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

  it('keeps the share denominator identical across modes (sum regions == sum macros == total)', async () => {
    // The choropleth card labels „Дял от всички области/райони" against `totalValueEur` in both modes;
    // that is only truthful if every oblast rolls into exactly one район, i.e. the two sums are equal.
    // If macroRegions ever stops being a pure roll-up of regions, this guard fails before it ships.
    const { regions, macroRegions, totalValueEur } = await getRegionalSpending(fakeDb(), {});
    const sumRegions = regions.reduce((s, r) => s + r.valueEur, 0);
    const sumMacros = macroRegions.reduce((s, m) => s + m.valueEur, 0);
    expect(sumRegions).toBe(sumMacros);
    expect(sumRegions).toBe(totalValueEur);
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

// Rows shaped like getRegionTopBeneficiaries' result columns. The SQL's ROW_NUMBER() OVER (...)
// window + `WHERE rn <= 3` already limits each region to its top 3 (desc by value_eur) before
// these rows reach JS — the fake DB below returns them as-is, so they're pre-shaped that way,
// same as the real query would return.
const BENEFICIARY_ROWS = [
  // Пловдив: exactly 3 rows (as if 4+ bidders existed and SQL trimmed to the top 3)
  { region: 'Пловдив', bidder_id: 'b1', name: 'Alpha OOD', value_eur: 3000, region_total: 6000 },
  { region: 'Пловдив', bidder_id: 'b2', name: 'Beta EOOD', value_eur: 2000, region_total: 6000 },
  { region: 'Пловдив', bidder_id: 'b3', name: 'Gamma AD', value_eur: 1000, region_total: 6000 },
  // Бургас: only 2 bidders total -> no padding to 3
  { region: 'Бургас', bidder_id: 'b4', name: 'Delta OOD', value_eur: 800, region_total: 1000 },
  { region: 'Бургас', bidder_id: 'b5', name: 'Epsilon EOOD', value_eur: 200, region_total: 1000 },
  // Unrecognized region name -> dropped entirely (no "unattributed" bucket for this feature)
  {
    region: 'Несъществуваща област',
    bidder_id: 'b6',
    name: 'Zeta AD',
    value_eur: 500,
    region_total: 500,
  },
];

function fakeBeneficiaryDb(capture?: { sql?: string; params?: unknown[] }): D1Database {
  return {
    prepare(sql: string) {
      if (capture) capture.sql = sql;
      return {
        bind(...params: unknown[]) {
          if (capture) capture.params = params;
          return this;
        },
        async all<T>() {
          return { results: BENEFICIARY_ROWS as T[] };
        },
      };
    },
  } as unknown as D1Database;
}

describe('getRegionTopBeneficiaries', () => {
  it('returns the top 3 bidders per region, descending by value', async () => {
    const map = await getRegionTopBeneficiaries(fakeBeneficiaryDb(), {});
    const plovdiv = map.get('BG421');
    expect(plovdiv).toHaveLength(3);
    expect(plovdiv?.map((b) => b.valueEur)).toEqual([3000, 2000, 1000]);
    expect(plovdiv?.[0]).toMatchObject({ bidderId: 'b1', name: 'Alpha OOD', valueEur: 3000 });
  });

  it('computes each bidder share against the region total across ALL bidders, not just the top 3', async () => {
    const map = await getRegionTopBeneficiaries(fakeBeneficiaryDb(), {});
    const plovdiv = map.get('BG421') ?? [];
    expect(plovdiv).toHaveLength(3);
    const [first, second, third] = plovdiv;
    expect(first?.share).toBeCloseTo(3000 / 6000);
    expect(second?.share).toBeCloseTo(2000 / 6000);
    expect(third?.share).toBeCloseTo(1000 / 6000);
  });

  it('returns fewer than 3 entries for a region with fewer than 3 bidders, with no padding', async () => {
    const map = await getRegionTopBeneficiaries(fakeBeneficiaryDb(), {});
    const burgas = map.get('BG341');
    expect(burgas).toHaveLength(2);
    expect(burgas?.map((b) => b.bidderId)).toEqual(['b4', 'b5']);
  });

  it('omits a region entirely when it has zero bidder rows', async () => {
    const map = await getRegionTopBeneficiaries(fakeBeneficiaryDb(), {});
    // Видин (BG311) has no rows in BENEFICIARY_ROWS at all
    expect(map.has('BG311')).toBe(false);
  });

  it('drops rows whose region does not map to a known NUTS3 code', async () => {
    const map = await getRegionTopBeneficiaries(fakeBeneficiaryDb(), {});
    for (const list of map.values()) {
      expect(list.some((b) => b.bidderId === 'b6')).toBe(false);
    }
    expect(map.size).toBe(2); // only Пловдив + Бургас mapped
  });

  it('guards against a zero region_total (no NaN/Infinity share)', async () => {
    function zeroTotalDb(): D1Database {
      return {
        prepare() {
          return {
            bind() {
              return this;
            },
            async all<T>() {
              return {
                results: [
                  {
                    region: 'Пловдив',
                    bidder_id: 'b1',
                    name: 'Alpha OOD',
                    value_eur: 0,
                    region_total: 0,
                  },
                ] as T[],
              };
            },
          };
        },
      } as unknown as D1Database;
    }
    const map = await getRegionTopBeneficiaries(zeroTotalDb(), {});
    const plovdiv = map.get('BG421') ?? [];
    expect(plovdiv).toHaveLength(1);
    expect(plovdiv[0]?.share).toBe(0);
  });

  it('builds the SAME WHERE-clause fragments and bound params as regionRows() for the same params', async () => {
    // Parity check that getRegionTopBeneficiaries and getRegionalSpending's (filtered) internal
    // regionRows() share the scopeFilters() helper and can't drift apart.
    const spendingCapture: string[] = [];
    await getRegionalSpending(fakeDb(spendingCapture), {
      sector: '45',
      year: '2023',
      funding: 'eu',
    });
    const spendingSql = spendingCapture.find((s) => s.includes('JOIN tenders t'));

    const beneficiaryCapture: { sql?: string; params?: unknown[] } = {};
    await getRegionTopBeneficiaries(fakeBeneficiaryDb(beneficiaryCapture), {
      sector: '45',
      year: '2023',
      funding: 'eu',
    });

    // Same filter fragments, in the same order, appear in both queries' WHERE clause.
    for (const fragment of [
      'c.amount_eur IS NOT NULL',
      'substr(t.cpv_code, 1, 2) = ?',
      'substr(c.signed_at, 1, 4) = ?',
      'c.eu_funded = 1',
    ]) {
      expect(spendingSql).toContain(fragment);
      expect(beneficiaryCapture.sql).toContain(fragment);
    }
    // Same bound scope params ('45', '2023'), modulo the beneficiary query's own extra params.
    expect(beneficiaryCapture.params?.slice(0, 2)).toEqual(['45', '2023']);
  });

  it('uses a single bounded window-function query, not per-region round trips', async () => {
    const capture: { sql?: string } = {};
    await getRegionTopBeneficiaries(fakeBeneficiaryDb(capture), {});
    expect(capture.sql).toContain(
      'ROW_NUMBER() OVER (PARTITION BY a.region ORDER BY SUM(c.amount_eur) DESC)',
    );
    expect(capture.sql).toContain('rn <= 3');
  });
});
