import { describe, expect, it } from 'vitest';
import { getSpendingTrend } from './trend';

// Fake D1 keyed by call type (same approach as competition.test.ts / regions.test.ts). Verifies the
// JS-side shaping: zero-filling gaps in the period series, the per-year summary with year-over-year
// change, coverage, and that the SQL uses month vs year substr and joins tenders only when filtering
// by sector.

const SERIES = [
  { period: '2022-01', value_eur: 1000, contracts: 10 },
  { period: '2022-03', value_eur: 3000, contracts: 30 }, // gap at 2022-02
  { period: '2023-01', value_eur: 5000, contracts: 50 },
];
const COVERAGE = { dated: 80, total: 100 };

interface QueryCall {
  sql: string;
  args: unknown[];
}

function fakeDb(capture?: string[], asOf: string | null = null): D1Database {
  return {
    prepare(sql: string) {
      capture?.push(sql);
      return {
        bind() {
          return this;
        },
        async all<T>() {
          return { results: SERIES as T[] };
        },
        async first<T>() {
          if (sql.includes('as_of')) return { as_of: asOf } as T;
          return COVERAGE as T;
        },
      };
    },
  } as unknown as D1Database;
}

const SCOPED_SERIES = {
  national: [
    { period: '2022', value_eur: 9000, contracts: 90 },
    { period: '2023', value_eur: 3000, contracts: 30 },
  ],
  authority: [
    { period: '2022', value_eur: 4000, contracts: 40 },
    { period: '2023', value_eur: 1000, contracts: 10 },
  ],
  bidder: [
    { period: '2022', value_eur: 2000, contracts: 20 },
    { period: '2023', value_eur: 500, contracts: 5 },
  ],
};

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
          if (this.args.includes('auth:111')) return { results: SCOPED_SERIES.authority as T[] };
          if (this.args.includes('eik:222')) return { results: SCOPED_SERIES.bidder as T[] };
          return { results: SCOPED_SERIES.national as T[] };
        },
        async first<T>() {
          if (sql.includes('as_of')) return { as_of: null } as T;
          if (this.args.includes('auth:111')) return { dated: 50, total: 60 } as T;
          if (this.args.includes('eik:222')) return { dated: 25, total: 30 } as T;
          return { dated: 120, total: 140 } as T;
        },
      };
    },
  } as unknown as D1Database;
}

describe('getSpendingTrend', () => {
  it('zero-fills gaps so the monthly series is continuous', async () => {
    const { points } = await getSpendingTrend(fakeDb(), {});
    expect(points).toHaveLength(13); // 2022-01 .. 2023-01 inclusive
    expect(points[0]!.period).toBe('2022-01');
    expect(points.at(-1)!.period).toBe('2023-01');
    expect(points.find((p) => p.period === '2022-02')).toMatchObject({ valueEur: 0, contracts: 0 });
  });

  it('folds months into a per-year summary with year-over-year change', async () => {
    const { years } = await getSpendingTrend(fakeDb(), {});
    expect(years).toEqual([
      { year: '2022', valueEur: 4000, contracts: 40, yoyPct: null, partial: false },
      { year: '2023', valueEur: 5000, contracts: 50, yoyPct: 0.25, partial: false }, // (5000 - 4000) / 4000
    ]);
  });

  it('marks the as_of period and year partial and suppresses the partial year YoY', async () => {
    const { points, years } = await getSpendingTrend(fakeDb(undefined, '2023-01-15'), {});
    expect(points.at(-1)).toMatchObject({ period: '2023-01', partial: true });
    expect(points.find((p) => p.period === '2022-03')).toMatchObject({ partial: false });
    const y2023 = years.find((y) => y.year === '2023')!;
    expect(y2023).toMatchObject({ partial: true, yoyPct: null });
    expect(years.find((y) => y.year === '2022')!.partial).toBe(false);
  });

  it('reports coverage of contracts with a usable signing date', async () => {
    const { coverage, totalValueEur } = await getSpendingTrend(fakeDb(), {});
    expect(coverage).toEqual({ dated: 80, total: 100, pct: 0.8 });
    expect(totalValueEur).toBe(9000); // 1000 + 3000 + 5000
  });

  it('uses month substr by default and year substr when asked', async () => {
    const month: string[] = [];
    await getSpendingTrend(fakeDb(month), {});
    expect(month.some((s) => s.includes('substr(c.signed_at, 1, 7)'))).toBe(true);

    const year: string[] = [];
    await getSpendingTrend(fakeDb(year), { granularity: 'year' });
    expect(year.some((s) => s.includes('substr(c.signed_at, 1, 4) AS period'))).toBe(true);
  });

  it('joins tenders only when a sector filter is set', async () => {
    const plain: string[] = [];
    await getSpendingTrend(fakeDb(plain), {});
    expect(plain.some((s) => s.includes('JOIN tenders'))).toBe(false);

    const filtered: string[] = [];
    await getSpendingTrend(fakeDb(filtered), { sector: '45' });
    expect(filtered.some((s) => s.includes('JOIN tenders t'))).toBe(true);
  });

  it('scopes the trend by authorityId through the tender authority', async () => {
    const national = await getSpendingTrend(scopedFakeDb([]), { granularity: 'year' });
    const calls: QueryCall[] = [];
    const scoped = await getSpendingTrend(scopedFakeDb(calls), {
      authorityId: 'auth:111',
      granularity: 'year',
    });

    expect(scoped.totalValueEur).toBe(5000);
    expect(scoped.totalValueEur).toBeLessThan(national.totalValueEur);
    expect(scoped.years).toMatchObject([
      { year: '2022', valueEur: 4000, contracts: 40 },
      { year: '2023', valueEur: 1000, contracts: 10 },
    ]);

    const series = calls.find((c) => c.sql.includes('GROUP BY period'))!;
    expect(series.sql).toContain('JOIN tenders t ON t.id = c.tender_id');
    expect(series.sql).toContain('t.authority_id = ?');
    expect(series.args).toEqual(['2020-01-01', 'auth:111']);
  });

  it('scopes the trend by bidderId through the contract bidder', async () => {
    const national = await getSpendingTrend(scopedFakeDb([]), { granularity: 'year' });
    const calls: QueryCall[] = [];
    const scoped = await getSpendingTrend(scopedFakeDb(calls), {
      bidderId: 'eik:222',
      granularity: 'year',
    });

    expect(scoped.totalValueEur).toBe(2500);
    expect(scoped.totalValueEur).toBeLessThan(national.totalValueEur);
    expect(scoped.years).toMatchObject([
      { year: '2022', valueEur: 2000, contracts: 20 },
      { year: '2023', valueEur: 500, contracts: 5 },
    ]);

    const series = calls.find((c) => c.sql.includes('GROUP BY period'))!;
    expect(series.sql).toContain('c.bidder_id = ?');
    expect(series.sql).not.toContain('JOIN tenders t');
    expect(series.args).toEqual(['2020-01-01', 'eik:222']);
  });
});
