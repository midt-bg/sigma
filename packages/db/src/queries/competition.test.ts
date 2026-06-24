import { describe, expect, it } from 'vitest';
import { getCompetition } from './competition';

// The query layer is pure SQL-building over D1; tests use a fake D1 that returns canned rows keyed by
// SQL markers (same approach as companies.test.ts). They verify the JS-side math (shares, HHI mapping,
// ranking) and that the unfiltered top-pairs path reads the flow_pairs rollup while a filter falls
// back to base aggregation, not the SQL engine itself.

const TOTALS = { contracts: 10, single_offer: 3, value_eur: 1000, single_value_eur: 400 };
const SINGLE_OFFER_ROWS = [
  {
    authority_id: 'auth:111',
    name: 'Община Тест',
    type_group: 'община',
    contracts: 50,
    single_offer: 40,
    value_eur: 5000,
  },
];
const CONCENTRATION_ROWS = [
  {
    authority_id: 'auth:222',
    name: 'Болница Тест',
    type_group: 'болница',
    suppliers: 3,
    contracts: 30,
    value_eur: 9000,
    hhi: 0.7,
  },
];
const FLOW_PAIRS = [
  {
    authority_id: 'auth:111',
    bidder_id: 'eik:333',
    authority_name: 'Община Тест',
    bidder_name: 'Фирма ООД',
    bidder_kind: 'company',
    won_eur: 1234,
    contracts: 9,
  },
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
          if (sql.includes('FROM sector_totals')) return { results: [{ division: '45' }] as T[] };
          if (sql.includes('FROM flow_pairs')) return { results: FLOW_PAIRS as T[] };
          if (sql.includes('JOIN bidders b')) return { results: FLOW_PAIRS as T[] }; // filtered pairs
          if (sql.includes('WITH pair AS')) return { results: CONCENTRATION_ROWS as T[] };
          return { results: SINGLE_OFFER_ROWS as T[] }; // single-offer leaderboard
        },
        async first<T>() {
          return TOTALS as T;
        },
      };
    },
  } as unknown as D1Database;
}

describe('getCompetition', () => {
  it('computes the headline single-offer shares by count and by value', async () => {
    const { totals } = await getCompetition(fakeDb(), {});
    expect(totals.singleOfferShare).toBeCloseTo(0.3); // 3 / 10
    expect(totals.singleOfferValueShare).toBeCloseTo(0.4); // 400 / 1000
  });

  it('maps the single-offer leaderboard: slug, type label, per-row share', async () => {
    const { bySingleOffer } = await getCompetition(fakeDb(), {});
    expect(bySingleOffer[0]).toMatchObject({
      slug: '111',
      name: 'Община Тест',
      typeLabel: 'община',
      singleOfferShare: 0.8, // 40 / 50
    });
  });

  it('passes the HHI through on the concentration leaderboard', async () => {
    const { byConcentration } = await getCompetition(fakeDb(), {});
    expect(byConcentration[0]).toMatchObject({ slug: '222', suppliers: 3, hhi: 0.7 });
  });

  it('ranks recurring pairs and resolves the company display name', async () => {
    const { topPairs } = await getCompetition(fakeDb(), {});
    expect(topPairs[0]).toMatchObject({
      rank: 1,
      authoritySlug: '111',
      bidderSlug: '333',
      contracts: 9,
    });
  });

  it('reads flow_pairs when unfiltered, but aggregates from base tables when filtered', async () => {
    const unfiltered: string[] = [];
    await getCompetition(fakeDb(unfiltered), {});
    expect(unfiltered.some((s) => s.includes('FROM flow_pairs'))).toBe(true);

    const filtered: string[] = [];
    await getCompetition(fakeDb(filtered), { sector: '45' });
    expect(filtered.some((s) => s.includes('FROM flow_pairs'))).toBe(false);
    expect(filtered.some((s) => s.includes('JOIN bidders b'))).toBe(true);
  });

  it('does not divide by zero on an empty corpus', async () => {
    const emptyDb = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all<T>() {
            return { results: [] as T[] };
          },
          async first<T>() {
            return { contracts: 0, single_offer: 0, value_eur: 0, single_value_eur: 0 } as T;
          },
        };
      },
    } as unknown as D1Database;
    const { totals, bySingleOffer } = await getCompetition(emptyDb, {});
    expect(totals.singleOfferShare).toBe(0);
    expect(totals.singleOfferValueShare).toBe(0);
    expect(bySingleOffer).toEqual([]);
  });
});
