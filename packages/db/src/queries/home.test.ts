import { describe, expect, it } from 'vitest';
import { fakeD1, type FakeD1 } from '@sigma/test-support';
import { getHomeData } from './home';

const authorityRow = {
  authority_id: 'auth:000695089',
  name: 'Министерство на финансите',
  type_group: 'министерство',
  settlement: 'София',
  region: 'Столична',
  spent_eur: 1000000,
  contracts: 100,
  suppliers: 30,
  avg_eur: 10000,
  primary_sector: '45',
  eu_eur: 200000,
  first_date: '2020-01-01',
  last_date: '2024-12-31',
};

const companyRow = {
  bidder_id: 'eik:103267194',
  name: 'ТЕСТ ООД',
  kind: 'company',
  ownership_kind: null,
  eik: '103267194',
  eik_valid: 1,
  settlement: 'София',
  won_eur: 50000,
  contracts: 5,
  authorities: 2,
  primary_sector: '45',
  eu_eur: 10000,
  first_date: '2022-01-01',
  last_date: '2024-06-01',
};

const contractRow = {
  id: 'c:1',
  subject: 'Тестов договор',
  unp: 'UNP-1',
  cpv_code: '45000000',
  eu_funded: 0,
  authority_id: 'auth:000695089',
  authority_name: 'Министерство на финансите',
  bidder_id: 'eik:103267194',
  bidder_name: 'ТЕСТ ООД',
  bidder_kind: 'company',
  procedure_type: 'Открита процедура',
  signed_at: '2024-01-01',
  bids_received: 1,
  amount_eur: 5000,
};

const totalsRow = {
  contracts: 500,
  value_eur: 1000000,
  authorities: 50,
  bidders: 200,
  suspect: 5,
  as_of: '2024-06-01',
  refreshed_at: '2024-06-02T10:00:00Z',
};

interface LiveSingleOffer {
  one_contracts: number;
  one_value: number;
  known_contracts: number;
  known_value: number;
}

function fake(
  totals: typeof totalsRow | null,
  // The live count of a database the refresh has not filled yet: one-offer contracts and their base.
  singleOffer: LiveSingleOffer | null = {
    one_contracts: 1,
    one_value: 50000,
    known_contracts: 4,
    known_value: 200000,
  },
  // The precomputed rows in facet_counts (single_offer/one and /known); empty before the refresh.
  storedSingleOffer: { key: string; value_eur: number; contracts: number }[] = [],
): FakeD1 {
  return fakeD1([
    { when: 'home_totals', first: totals },
    { when: "facet = 'single_offer'", all: storedSingleOffer },
    { when: 'company_totals', all: [companyRow] },
    { when: "type_group = 'община'", all: [authorityRow] },
    { when: 'type_group IN', all: [authorityRow] },
    // listSingleOfferContracts (two calls: 'recent' by date, 'value' by amount)
    { when: ['bids_received = 1', 'JOIN'], all: [contractRow] },
    // the live single-offer count, which reads the same table without a join
    { when: 'AS known_value', first: singleOffer },
  ]);
}

describe('getHomeData', () => {
  it('returns zero-value fallback totals when home_totals has no row', async () => {
    const data = await getHomeData(fake(null).db);

    expect(data.totals.contracts).toBe(0);
    expect(data.totals.valueEur).toBe(0);
    expect(data.totals.authorities).toBe(0);
    expect(data.totals.asOf).toBeNull();
  });

  it('maps home_totals row to HomeData.totals', async () => {
    const data = await getHomeData(fake(totalsRow).db);

    expect(data.totals.contracts).toBe(500);
    expect(data.totals.valueEur).toBe(1000000);
    expect(data.totals.asOf).toBe('2024-06-01');
    expect(data.totals.refreshedAt).toBe('2024-06-02T10:00:00Z');
  });

  it('includes top companies, ministries, and municipalities', async () => {
    const data = await getHomeData(fake(totalsRow).db);

    expect(data.topCompanies).toHaveLength(1);
    expect(data.topCompanies[0]!.slug).toBe('103267194');

    expect(data.topMinistries).toHaveLength(1);
    expect(data.topMinistries[0]!.slug).toBe('000695089');

    expect(data.topMunicipalities).toHaveLength(1);
  });

  it('excludes the unknown identity bucket from top companies', async () => {
    const calls = fake(totalsRow);
    await getHomeData(calls.db);

    expect(calls.sql.find((query) => query.includes('FROM company_totals'))).toContain(
      "WHERE kind <> 'unknown'",
    );
  });

  it('includes single-offer contract lists', async () => {
    const data = await getHomeData(fake(totalsRow).db);

    expect(Array.isArray(data.recentSingleOffer)).toBe(true);
    expect(Array.isArray(data.topSingleOffer)).toBe(true);
  });

  it('includes the single-offer share against contracts with a known number of offers', async () => {
    const data = await getHomeData(fake(totalsRow).db);

    expect(data.singleOffer).toEqual({
      valueEur: 50000,
      contracts: 1,
      // the base is not the whole corpus (totals.valueEur 1 000 000) but the contracts whose number of
      // offers is known — the base /analytics and /competition use
      baseValueEur: 200000,
      baseContracts: 4,
    });
  });

  it('falls back to a zero share when the live count returns no row', async () => {
    const data = await getHomeData(fake(totalsRow, null).db);

    expect(data.singleOffer).toEqual({
      valueEur: 0,
      contracts: 0,
      baseValueEur: 0,
      baseContracts: 0,
    });
  });

  it('reads the precomputed single-offer rows instead of scanning the contracts', async () => {
    const calls = fake(totalsRow, null, [
      { key: 'one', value_eur: 70000, contracts: 3 },
      { key: 'known', value_eur: 140000, contracts: 9 },
    ]);
    const data = await getHomeData(calls.db);

    expect(data.singleOffer).toEqual({
      valueEur: 70000,
      contracts: 3,
      baseValueEur: 140000,
      baseContracts: 9,
    });
    expect(calls.sql.some((query) => query.includes('AS known_value'))).toBe(false);
  });

  it('counts live while only one of the two rows exists', async () => {
    const calls = fake(totalsRow, undefined, [{ key: 'one', value_eur: 70000, contracts: 3 }]);
    expect((await getHomeData(calls.db)).singleOffer.baseValueEur).toBe(200000);
  });
});
