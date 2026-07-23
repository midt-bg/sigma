import { describe, expect, it } from 'vitest';
import { getMethodologyStats } from './methodology';

function fakeDb(opts: {
  totalsRow?: object | null;
  coverageRow?: object | null;
  sectorsRow?: object | null;
}): D1Database {
  return {
    prepare(sql: string) {
      return {
        async first<T>() {
          if (sql.includes('home_totals')) return (opts.totalsRow ?? null) as T;
          if (sql.includes('COUNT(bids_received)')) return (opts.coverageRow ?? null) as T;
          if (sql.includes('sector_totals')) return (opts.sectorsRow ?? null) as T;
          return null as T;
        },
      };
    },
  } as D1Database;
}

describe('getMethodologyStats', () => {
  it('returns zero-value fallback totals when home_totals is empty', async () => {
    const db = fakeDb({ totalsRow: null, coverageRow: null, sectorsRow: null });
    const stats = await getMethodologyStats(db);

    expect(stats.totals.contracts).toBe(0);
    expect(stats.totals.valueEur).toBe(0);
    expect(stats.totals.authorities).toBe(0);
    expect(stats.totals.asOf).toBeNull();
    expect(stats.coverage.bids).toBe(0);
    expect(stats.sectors).toBe(0);
  });

  it('maps home_totals row to the totals shape', async () => {
    const db = fakeDb({
      totalsRow: {
        contracts: 12345,
        value_eur: 9876543,
        authorities: 200,
        bidders: 1500,
        suspect: 10,
        first_date: '2018-01-01',
        last_date: '2024-12-31',
        as_of: '2024-06-01',
        refreshed_at: '2024-06-02T10:00:00Z',
      },
      coverageRow: null,
      sectorsRow: null,
    });

    const stats = await getMethodologyStats(db);
    expect(stats.totals.contracts).toBe(12345);
    expect(stats.totals.valueEur).toBe(9876543);
    expect(stats.totals.asOf).toBe('2024-06-01');
    expect(stats.firstDate).toBe('2018-01-01');
    expect(stats.lastDate).toBe('2024-12-31');
  });

  it('computes field coverage ratios relative to total row count', async () => {
    const db = fakeDb({
      totalsRow: {
        contracts: 100,
        value_eur: 0,
        authorities: 0,
        bidders: 0,
        suspect: 0,
        first_date: null,
        last_date: null,
        as_of: null,
        refreshed_at: '',
      },
      coverageRow: { total: 100, bids: 80, eu: 50, dur: 60, lot: 20 },
      sectorsRow: { n: 15 },
    });

    const stats = await getMethodologyStats(db);
    expect(stats.coverage.bids).toBeCloseTo(0.8);
    expect(stats.coverage.eu).toBeCloseTo(0.5);
    expect(stats.coverage.duration).toBeCloseTo(0.6);
    expect(stats.coverage.lot).toBeCloseTo(0.2);
    expect(stats.sectors).toBe(15);
  });

  it('returns zero ratios when total is 0 (avoids division by zero)', async () => {
    const db = fakeDb({
      totalsRow: null,
      coverageRow: { total: 0, bids: 0, eu: 0, dur: 0, lot: 0 },
      sectorsRow: { n: 0 },
    });

    const stats = await getMethodologyStats(db);
    expect(stats.coverage.bids).toBe(0);
    expect(stats.coverage.eu).toBe(0);
  });
});

describe('getMethodologyStats — absent coverage counts with a positive total', () => {
  it('coalesces a missing per-field count to zero (n ?? 0) when total > 0', async () => {
    const db = fakeDb({
      totalsRow: null,
      coverageRow: { total: 100 }, // bids/eu/dur/lot fields absent
      sectorsRow: null,
    });
    const stats = await getMethodologyStats(db);
    expect(stats.coverage.bids).toBe(0);
    expect(stats.coverage.eu).toBe(0);
    expect(stats.coverage.duration).toBe(0);
    expect(stats.coverage.lot).toBe(0);
  });
});
