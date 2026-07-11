import { describe, expect, it } from 'vitest';
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

function fakeDb(totals: typeof totalsRow | null): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async all<T>() {
          if (sql.includes('company_totals')) return { results: [companyRow] as T[] };
          if (sql.includes("type_group = 'община'")) return { results: [authorityRow] as T[] };
          if (sql.includes('type_group IN')) return { results: [authorityRow] as T[] };
          // listSingleOfferContracts (two calls: 'recent' by date, 'value' by amount)
          if (sql.includes('bids_received = 1') && sql.includes('JOIN')) {
            return { results: [contractRow] as T[] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          if (sql.includes('home_totals')) return (totals as T) ?? (null as T);
          // single-offer aggregate
          if (sql.includes('COALESCE(SUM(amount_eur)'))
            return { value_eur: 50000, contracts: 1 } as T;
          return null as T;
        },
      };
    },
  } as D1Database;
}

describe('getHomeData', () => {
  it('returns zero-value fallback totals when home_totals has no row', async () => {
    const data = await getHomeData(fakeDb(null));

    expect(data.totals.contracts).toBe(0);
    expect(data.totals.valueEur).toBe(0);
    expect(data.totals.authorities).toBe(0);
    expect(data.totals.asOf).toBeNull();
  });

  it('maps home_totals row to HomeData.totals', async () => {
    const data = await getHomeData(fakeDb(totalsRow));

    expect(data.totals.contracts).toBe(500);
    expect(data.totals.valueEur).toBe(1000000);
    expect(data.totals.asOf).toBe('2024-06-01');
    expect(data.totals.refreshedAt).toBe('2024-06-02T10:00:00Z');
  });

  it('includes top companies, ministries, and municipalities', async () => {
    const data = await getHomeData(fakeDb(totalsRow));

    expect(data.topCompanies).toHaveLength(1);
    expect(data.topCompanies[0]!.slug).toBe('103267194');

    expect(data.topMinistries).toHaveLength(1);
    expect(data.topMinistries[0]!.slug).toBe('000695089');

    expect(data.topMunicipalities).toHaveLength(1);
  });

  it('includes single-offer contract lists', async () => {
    const data = await getHomeData(fakeDb(totalsRow));

    expect(Array.isArray(data.recentSingleOffer)).toBe(true);
    expect(Array.isArray(data.topSingleOffer)).toBe(true);
  });

  it('includes single-offer aggregate stats', async () => {
    const data = await getHomeData(fakeDb(totalsRow));

    expect(data.singleOffer.contracts).toBe(1);
    expect(data.singleOffer.valueEur).toBe(50000);
  });
});
