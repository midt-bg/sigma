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
// Procedure mix for the direct-award headline: 6 competitive + 2 non-competitive (classified = 8),
// 1 neutral, 1 synthetic. Uses the real @sigma/config procedure_type strings so procedureGroup folds.
const PROCEDURE_ROWS = [
  { procedure_type: 'Открита процедура', contracts: 6, value_eur: 6000 }, // competitive
  { procedure_type: 'Пряко договаряне', contracts: 2, value_eur: 2000 }, // non-competitive
  { procedure_type: 'Покана до определени лица', contracts: 1, value_eur: 500 }, // neutral
  { procedure_type: 'неизвестна', contracts: 1, value_eur: 0 }, // synthetic
];
const DIRECT_AWARD_ROWS = [
  {
    authority_id: 'auth:555',
    name: 'Агенция Тест',
    type_group: 'агенция',
    classified: 20,
    non_competitive: 12,
    value_eur: 8000,
  },
];

interface QueryCall {
  sql: string;
  args: unknown[];
}

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
          if (sql.includes('GROUP BY t.procedure_type')) return { results: PROCEDURE_ROWS as T[] };
          if (sql.includes('TRIM(t.procedure_type) IN ('))
            return { results: DIRECT_AWARD_ROWS as T[] };
          return { results: SINGLE_OFFER_ROWS as T[] }; // single-offer leaderboard
        },
        async first<T>() {
          return TOTALS as T;
        },
      };
    },
  } as unknown as D1Database;
}

const SCOPED_TOTALS = { contracts: 4, single_offer: 1, value_eur: 600, single_value_eur: 150 };
const SCOPED_SINGLE_OFFER_ROWS = [
  {
    authority_id: 'auth:111',
    name: 'Община Тест',
    type_group: 'община',
    contracts: 4,
    single_offer: 1,
    value_eur: 600,
  },
];
const SCOPED_CONCENTRATION_ROWS = [
  {
    authority_id: 'auth:111',
    name: 'Община Тест',
    type_group: 'община',
    suppliers: 2,
    contracts: 4,
    value_eur: 600,
    hhi: 0.625,
  },
];
const SCOPED_FLOW_PAIRS = [
  {
    authority_id: 'auth:111',
    bidder_id: 'eik:444',
    authority_name: 'Община Тест',
    bidder_name: 'Скоп Фирма АД',
    bidder_kind: 'company',
    won_eur: 600,
    contracts: 4,
  },
];

function scopedFakeDb(calls: QueryCall[]): D1Database {
  return {
    prepare(sql: string) {
      return {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          this.args = args;
          calls.push({ sql, args });
          return this;
        },
        async all<T>() {
          if (sql.includes('FROM sector_totals')) return { results: [{ division: '45' }] as T[] };
          if (sql.includes('GROUP BY t.procedure_type')) return { results: PROCEDURE_ROWS as T[] };
          if (sql.includes('TRIM(t.procedure_type) IN ('))
            return { results: DIRECT_AWARD_ROWS as T[] };
          if (!this.args.includes('auth:111')) {
            if (sql.includes('FROM flow_pairs')) return { results: FLOW_PAIRS as T[] };
            if (sql.includes('WITH pair AS')) return { results: CONCENTRATION_ROWS as T[] };
            return { results: SINGLE_OFFER_ROWS as T[] };
          }
          if (sql.includes('JOIN bidders b')) return { results: SCOPED_FLOW_PAIRS as T[] };
          if (sql.includes('WITH pair AS')) return { results: SCOPED_CONCENTRATION_ROWS as T[] };
          return { results: SCOPED_SINGLE_OFFER_ROWS as T[] };
        },
        async first<T>() {
          return (this.args.includes('auth:111') ? SCOPED_TOTALS : TOTALS) as T;
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

  it('folds the procedure mix into the direct-award headline', async () => {
    const { procedure } = await getCompetition(fakeDb(), {});
    expect(procedure).toMatchObject({
      competitiveContracts: 6,
      nonCompetitiveContracts: 2,
      classifiedContracts: 8, // competitive + non-competitive (neutral/synthetic excluded)
      neutralContracts: 1,
      unknownContracts: 1,
      totalContracts: 10,
    });
    expect(procedure.nonCompetitiveShare).toBeCloseTo(0.25); // 2 / 8
    expect(procedure.nonCompetitiveValueShare).toBeCloseTo(0.25); // 2000 / 8000
  });

  it('maps the direct-award leaderboard with per-row share', async () => {
    const { byDirectAward } = await getCompetition(fakeDb(), {});
    expect(byDirectAward[0]).toMatchObject({ slug: '555', classified: 20, nonCompetitive: 12 });
    expect(byDirectAward[0]?.nonCompetitiveShare ?? 0).toBeCloseTo(0.6); // 12 / 20
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

  it('scopes competition indicators by authorityId', async () => {
    const national = await getCompetition(scopedFakeDb([]), { minContracts: 1 });
    const calls: QueryCall[] = [];
    const scoped = await getCompetition(scopedFakeDb(calls), {
      authorityId: 'auth:111',
      minContracts: 1,
    });

    expect(scoped.totals).toMatchObject({
      contracts: 4,
      singleOffer: 1,
      singleOfferShare: 0.25,
      valueEur: 600,
      singleOfferValueEur: 150,
      singleOfferValueShare: 0.25,
    });
    expect(scoped.totals.valueEur).toBeLessThan(national.totals.valueEur);
    expect(scoped.bySingleOffer).toHaveLength(1);
    expect(scoped.bySingleOffer[0]).toMatchObject({
      slug: '111',
      contracts: 4,
      singleOffer: 1,
      singleOfferShare: 0.25,
    });
    expect(scoped.byConcentration[0]).toMatchObject({ slug: '111', suppliers: 2, hhi: 0.625 });
    expect(scoped.topPairs[0]).toMatchObject({
      authoritySlug: '111',
      bidderSlug: '444',
      wonEur: 600,
      contracts: 4,
    });

    expect(calls.some((c) => c.sql.includes('FROM flow_pairs'))).toBe(false);
    expect(calls.some((c) => c.sql.includes('t.authority_id = ?'))).toBe(true);
    // totals, procedure-mix, single-offer, concentration, direct-award, recurring-pairs all scope to it
    expect(calls.filter((c) => c.args.includes('auth:111'))).toHaveLength(6);
  });
});
