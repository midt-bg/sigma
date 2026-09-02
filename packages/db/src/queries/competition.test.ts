import { describe, expect, it } from 'vitest';
import { fakeD1, type FakeD1, type FakeD1Call } from '@sigma/test-support';
import {
  getAuthorityProcedureCompetition,
  getAuthoritySingleOffer,
  getCompetition,
  getCompetitionSummary,
} from './competition';

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

// The single-offer leaderboard and the corpus totals have no table of their own — both aggregate the
// contracts join — so these column aliases are what tells them apart from the other reads.
const SINGLE_OFFER_BOARD = 'AS single_offer';
const CORPUS_TOTALS = 'AS single_value_eur';

function fakeDb(): FakeD1 {
  return fakeD1([
    { when: 'FROM sector_totals', all: [{ division: '45' }] },
    { when: 'FROM flow_pairs', all: FLOW_PAIRS },
    { when: 'JOIN bidders b', all: FLOW_PAIRS }, // filtered pairs
    { when: 'WITH pair AS', all: CONCENTRATION_ROWS },
    { when: 'GROUP BY t.procedure_type', all: PROCEDURE_ROWS },
    { when: 'TRIM(t.procedure_type) IN (', all: DIRECT_AWARD_ROWS },
    { when: SINGLE_OFFER_BOARD, all: SINGLE_OFFER_ROWS },
    { when: CORPUS_TOTALS, first: TOTALS },
  ]);
}

/** Whether a call is the authority-scoped one — that is in its bound arguments, not its SQL. */
const scopedCall = (call: FakeD1Call) => call.binds.includes('auth:111');

function scopedFakeDb(): FakeD1 {
  return fakeD1([
    { when: 'FROM sector_totals', all: [{ division: '45' }] },
    { when: 'GROUP BY t.procedure_type', all: PROCEDURE_ROWS },
    { when: 'TRIM(t.procedure_type) IN (', all: DIRECT_AWARD_ROWS },
    { when: 'FROM flow_pairs', all: FLOW_PAIRS },
    { when: 'JOIN bidders b', all: (c) => (scopedCall(c) ? SCOPED_FLOW_PAIRS : FLOW_PAIRS) },
    {
      when: 'WITH pair AS',
      all: (c) => (scopedCall(c) ? SCOPED_CONCENTRATION_ROWS : CONCENTRATION_ROWS),
    },
    {
      when: SINGLE_OFFER_BOARD,
      all: (c) => (scopedCall(c) ? SCOPED_SINGLE_OFFER_ROWS : SINGLE_OFFER_ROWS),
    },
    { when: CORPUS_TOTALS, first: (c) => (scopedCall(c) ? SCOPED_TOTALS : TOTALS) },
  ]);
}

describe('getCompetition', () => {
  it('computes the headline single-offer shares by count and by value', async () => {
    const { totals } = await getCompetition(fakeDb().db, {});
    expect(totals.singleOfferShare).toBeCloseTo(0.3); // 3 / 10
    expect(totals.singleOfferValueShare).toBeCloseTo(0.4); // 400 / 1000
  });

  it('maps the single-offer leaderboard: slug, type label, per-row share', async () => {
    const { bySingleOffer } = await getCompetition(fakeDb().db, {});
    expect(bySingleOffer[0]).toMatchObject({
      slug: '111',
      name: 'Община Тест',
      typeLabel: 'община',
      singleOfferShare: 0.8, // 40 / 50
    });
  });

  it('passes the HHI through on the concentration leaderboard', async () => {
    const { byConcentration } = await getCompetition(fakeDb().db, {});
    expect(byConcentration[0]).toMatchObject({ slug: '222', suppliers: 3, hhi: 0.7 });
  });

  it('folds the procedure mix into the direct-award headline', async () => {
    const { procedure } = await getCompetition(fakeDb().db, {});
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
    const { byDirectAward } = await getCompetition(fakeDb().db, {});
    expect(byDirectAward[0]).toMatchObject({ slug: '555', classified: 20, nonCompetitive: 12 });
    expect(byDirectAward[0]?.nonCompetitiveShare ?? 0).toBeCloseTo(0.6); // 12 / 20
  });

  it('ranks recurring pairs and resolves the company display name', async () => {
    const { topPairs } = await getCompetition(fakeDb().db, {});
    expect(topPairs[0]).toMatchObject({
      rank: 1,
      authoritySlug: '111',
      bidderSlug: '333',
      contracts: 9,
    });
  });

  it('reads flow_pairs when unfiltered, but aggregates from base tables when filtered', async () => {
    const unfiltered = fakeDb();
    await getCompetition(unfiltered.db, {});
    expect(unfiltered.sql.some((s) => s.includes('FROM flow_pairs'))).toBe(true);

    const filtered = fakeDb();
    await getCompetition(filtered.db, { sector: '45' });
    expect(filtered.sql.some((s) => s.includes('FROM flow_pairs'))).toBe(false);
    expect(filtered.sql.some((s) => s.includes('JOIN bidders b'))).toBe(true);
  });

  it('does not divide by zero on an empty corpus', async () => {
    const emptyDb = fakeD1([
      {
        when: CORPUS_TOTALS,
        first: { contracts: 0, single_offer: 0, value_eur: 0, single_value_eur: 0 },
      },
      { when: 'FROM sector_totals', all: [] },
      { when: 'FROM flow_pairs', all: [] },
      { when: 'JOIN bidders b', all: [] },
      { when: 'WITH pair AS', all: [] },
      { when: 'GROUP BY t.procedure_type', all: [] },
      { when: 'TRIM(t.procedure_type) IN (', all: [] },
      { when: SINGLE_OFFER_BOARD, all: [] },
    ]).db;
    const { totals, bySingleOffer } = await getCompetition(emptyDb, {});
    expect(totals.singleOfferShare).toBe(0);
    expect(totals.singleOfferValueShare).toBe(0);
    expect(bySingleOffer).toEqual([]);
  });

  it('handles a degenerate corpus: null totals row, zero-contract rows, empty classified set', async () => {
    // Sweeps the zero-guard false branches: `contracts > 0 ? … : 0`, `classified > 0 ? … : 0`,
    // `classifiedContracts > 0 ? … : 0`, the `row?.x ?? 0` nullish fallbacks, and the year scope filter.
    const db = fakeD1([
      { when: CORPUS_TOTALS, first: null }, // totals row missing → every `row?.x ?? 0` falls back
      { when: 'FROM sector_totals', all: [] },
      { when: 'FROM flow_pairs', all: [] },
      { when: 'JOIN bidders b', all: [] },
      { when: 'WITH pair AS', all: [] },
      {
        when: 'GROUP BY t.procedure_type',
        all: [
          { procedure_type: 'Покана до определени лица', contracts: 1, value_eur: 0 }, // neutral
          { procedure_type: 'неизвестна', contracts: 1, value_eur: 0 }, // unknown → 0 classified
        ],
      },
      {
        when: 'TRIM(t.procedure_type) IN (',
        all: [
          {
            authority_id: 'auth:9',
            name: 'X',
            type_group: null,
            classified: 0,
            non_competitive: 0,
            value_eur: 0,
          },
        ],
      },
      {
        when: SINGLE_OFFER_BOARD,
        all: [
          {
            authority_id: 'auth:9',
            name: 'X',
            type_group: null,
            contracts: 0,
            single_offer: 0,
            value_eur: 0,
          },
        ],
      },
    ]).db;
    const data = await getCompetition(db, { year: '2024' });
    expect(data.totals.singleOfferShare).toBe(0);
    expect(data.totals.valueEur).toBe(0);
    expect(data.bySingleOffer[0]?.singleOfferShare).toBe(0); // r.contracts 0 → 0
    expect(data.byDirectAward[0]?.nonCompetitiveShare).toBe(0); // r.classified 0 → 0
    expect(data.procedure.nonCompetitiveShare).toBe(0); // classifiedContracts 0 → 0
    expect(data.procedure.nonCompetitiveValueShare).toBe(0); // classifiedValueEur 0 → 0
    expect(data.scope.year).toBe(2024); // year scoped through Number()
  });

  it('offers exactly two leaderboard sizes — MAX_TOP on an exact request, otherwise the default', async () => {
    // Not a clamp: the source is `p.top === MAX_TOP ? MAX_TOP : DEFAULT_TOP`, so anything that is not
    // exactly 50 falls back to 20 rather than being reduced to 50. That fallback is the half that
    // matters — it is what stops a caller from naming its own leaderboard size (and its own LIMIT).
    expect((await getCompetition(fakeDb().db, { top: 50 })).scope.top).toBe(50);

    for (const top of [999, 51, 35, 0, -1, Number.NaN]) {
      expect((await getCompetition(fakeDb().db, { top })).scope.top).toBe(20);
    }
    expect((await getCompetition(fakeDb().db, {})).scope.top).toBe(20); // omitted → default
  });

  it('scopes every panel by EU funding', async () => {
    const calls = fakeDb();
    await getCompetition(calls.db, { funding: 'eu' });
    expect(calls.sql.some((s) => s.includes('c.eu_funded = 1'))).toBe(true);
  });

  it('scopes every panel by national funding', async () => {
    const calls = fakeDb();
    await getCompetition(calls.db, { funding: 'national' });
    expect(calls.sql.some((s) => s.includes('c.eu_funded IS NULL OR c.eu_funded = 0'))).toBe(true);
  });

  it('scopes competition indicators by authorityId', async () => {
    const national = await getCompetition(scopedFakeDb().db, { minContracts: 1 });
    const calls = scopedFakeDb();
    const scoped = await getCompetition(calls.db, {
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

    expect(calls.calls.some((c) => c.sql.includes('FROM flow_pairs'))).toBe(false);
    expect(calls.calls.some((c) => c.sql.includes('t.authority_id = ?'))).toBe(true);
    // totals, procedure-mix, single-offer, concentration, direct-award, recurring-pairs all scope to it
    expect(calls.calls.filter((c) => c.binds.includes('auth:111'))).toHaveLength(6);
  });
});

describe('authority-detail wrappers', () => {
  it('getAuthoritySingleOffer returns the single-offer totals for one authority', async () => {
    const calls = fakeDb();
    const totals = await getAuthoritySingleOffer(calls.db, 'auth:111');
    expect(totals.singleOfferShare).toBeCloseTo(0.3); // 3 / 10 from TOTALS
    expect(calls.sql.some((s) => s.includes('t.authority_id = ?'))).toBe(true); // scoped
  });

  it('getAuthorityProcedureCompetition folds the procedure mix for one authority', async () => {
    const calls = fakeDb();
    const proc = await getAuthorityProcedureCompetition(calls.db, 'auth:111');
    expect(proc).toMatchObject({ classifiedContracts: 8, nonCompetitiveContracts: 2 });
    expect(proc.nonCompetitiveShare).toBeCloseTo(0.25); // 2 / 8
    expect(calls.sql.some((s) => s.includes('t.authority_id = ?'))).toBe(true);
  });
});

describe('getCompetitionSummary', () => {
  it('returns totals and the single most-concentrated authority (default params)', async () => {
    const summary = await getCompetitionSummary(fakeDb().db);
    expect(summary.totals.singleOfferShare).toBeCloseTo(0.3);
    expect(summary.topConcentration).toMatchObject({ slug: '222', hhi: 0.7 });
  });

  it('yields a null topConcentration when no authority qualifies', async () => {
    const emptyDb = fakeD1([
      {
        when: CORPUS_TOTALS,
        first: { contracts: 0, single_offer: 0, value_eur: 0, single_value_eur: 0 },
      },
      { when: 'FROM sector_totals', all: [] },
      { when: 'FROM flow_pairs', all: [] },
      { when: 'JOIN bidders b', all: [] },
      { when: 'WITH pair AS', all: [] },
      { when: 'GROUP BY t.procedure_type', all: [] },
      { when: 'TRIM(t.procedure_type) IN (', all: [] },
      { when: SINGLE_OFFER_BOARD, all: [] },
    ]).db;
    const summary = await getCompetitionSummary(emptyDb, { minContracts: 5 });
    expect(summary.topConcentration).toBeNull(); // byConcentration[0] ?? null
    expect(summary.totals.contracts).toBe(0);
  });
});
