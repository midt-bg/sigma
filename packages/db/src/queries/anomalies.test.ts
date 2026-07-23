import { describe, expect, it } from 'vitest';
import { getAnomalyFacets, listAnomalies, anomaliesSummary } from './anomalies';

const anomalyRow = {
  id: 'c:1',
  subject: 'Доставка на материали',
  unp: 'UNP-1',
  cpv_division: '45',
  signed_at: '2024-03-01',
  amount_eur: 500000,
  score: 60,
  flag_over_estimate: 1,
  over_estimate_ratio: 2.5,
  estimated_eur: 200000,
  flag_annex_growth: 0,
  annex_growth_ratio: 1.05, // stored under threshold — must NOT surface (flag is 0)
  flag_price_outlier: 1,
  price_ratio: 12,
  peer_median_eur: 41666,
  peer_count: 120,
  flag_single_bid: 1,
  flag_no_notice: 0,
  authority_id: 'auth:000695089',
  authority_name: 'Министерство на финансите',
  bidder_id: 'eik:111111111',
  bidder_name: 'ТЕСТ ООД',
  bidder_kind: 'company' as const,
  sort_value: 60e12 + 500000,
};

function fakeDb(rows: (typeof anomalyRow)[] = [anomalyRow]): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async all<T>() {
          return { results: (sql.includes('1=0') ? [] : rows) as T[] };
        },
        async first<T>() {
          const total = sql.includes('1=0') ? 0 : rows.length;
          return { total, eur: total ? 500000 : 0 } as T;
        },
      };
    },
  } as D1Database;
}

// SQL-capturing fake: records every prepared statement so the filter-shape tests assert on the
// query text (there is no real D1 here), mirroring flows.test.ts.
function spyDb(): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const db = {
    prepare(q: string) {
      sql.push(q);
      return {
        bind() {
          return this;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async first<T>() {
          return { total: 0, eur: 0 } as T;
        },
      };
    },
  } as D1Database;
  return { db, sql };
}

describe('listAnomalies', () => {
  it('maps a row and surfaces ratios only for fired flags', async () => {
    const page = await listAnomalies(fakeDb(), { pageSize: 10 });

    expect(page.total).toBe(1);
    const item = page.items[0]!;
    expect(item.id).toBe('1'); // contractSlug strips the 'c:' domain prefix
    expect(item.score).toBe(60);
    expect(item.valueEur).toBe(500000);
    // over_estimate + price_outlier fired → ratios present; annex flag is 0 → its stored
    // under-threshold ratio stays hidden.
    expect(item.signals.overEstimateRatio).toBe(2.5);
    expect(item.signals.estimatedEur).toBe(200000);
    expect(item.signals.priceRatio).toBe(12);
    expect(item.signals.peerMedianEur).toBe(41666);
    expect(item.signals.peerCount).toBe(120);
    expect(item.signals.annexGrowthRatio).toBeNull();
    expect(item.signals.singleBid).toBe(true);
    expect(item.signals.noNotice).toBe(false);
  });

  it('returns no rows for an undecodable bidder slug', async () => {
    const page = await listAnomalies(fakeDb(), { bidder: 'n%', pageSize: 10 });

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('falls back to the default sort instead of throwing (sort=toString)', async () => {
    await expect(
      listAnomalies(fakeDb(), { sort: 'toString' as never, pageSize: 10 }),
    ).resolves.toBeDefined();
  });

  it('filters signals via the precomputed flag columns (no re-stated thresholds)', async () => {
    const { db, sql } = spyDb();
    await listAnomalies(db, { signals: ['over_estimate', 'single_bid'], pageSize: 10 });

    const listSql = sql.find((q) => q.includes('FROM contract_anomalies an'))!;
    expect(listSql).toContain('an.flag_over_estimate = 1 OR an.flag_single_bid = 1');
  });

  it('yields an empty result (not an unfiltered list) when only unknown signal keys are given', async () => {
    const { db, sql } = spyDb();
    await listAnomalies(db, { signals: ['constructor'], pageSize: 10 });

    const listSql = sql.find((q) => q.includes('FROM contract_anomalies an'))!;
    expect(listSql).toContain('1=0');
  });

  it('keeps every filter predicate on the anomaly table (an.*)', async () => {
    const { db, sql } = spyDb();
    await listAnomalies(db, {
      years: ['2024'],
      sectors: ['45'],
      valueBucket: '1m-10m',
      authority: '000695089',
      pageSize: 10,
    });

    const listSql = sql.find((q) => q.includes('FROM contract_anomalies an'))!;
    expect(listSql).toContain("substr(an.signed_at, 1, 4) IN (?)");
    expect(listSql).toContain('an.cpv_division IN (?)');
    expect(listSql).toContain('an.amount_eur >= ? AND an.amount_eur < ?');
    expect(listSql).toContain('an.authority_id = ?');
  });
});

describe('anomaliesSummary', () => {
  it('ignores a reserved value-bucket key instead of a destructure TypeError (value=toString)', async () => {
    await expect(
      anomaliesSummary(fakeDb(), { valueBucket: 'toString' }),
    ).resolves.toMatchObject({ total: 1 });
  });
});

describe('getAnomalyFacets', () => {
  it('maps signal counts in display order and drops empty buckets', async () => {
    const db = {
      prepare(sql: string) {
        return {
          async all<T>() {
            if (sql.includes('cpv_division')) {
              return { results: [{ key: '45', contracts: 7 }] as T[] };
            }
            return { results: [{ key: '2024', contracts: 9 }] as T[] };
          },
          async first<T>() {
            return {
              over_estimate: 5,
              annex_growth: 0,
              price_outlier: 3,
              single_bid: 2,
              no_notice: 0,
            } as T;
          },
        };
      },
    } as D1Database;

    const facets = await getAnomalyFacets(db);

    expect(facets.signals.map((s) => s.value)).toEqual([
      'over_estimate',
      'price_outlier',
      'single_bid',
    ]);
    expect(facets.signals[0]).toMatchObject({ count: 5 });
    expect(facets.sectors[0]).toMatchObject({ value: '45', count: 7 });
    expect(facets.years[0]).toMatchObject({ value: '2024', label: '2024', count: 9 });
  });
});
