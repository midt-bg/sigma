import { describe, expect, it, vi } from 'vitest';
import { fakeD1, type FakeD1 } from '@sigma/test-support';
import {
  getCpvGroupMedians,
  getCpvGroupStats,
  getSpendingTrend,
  listOverviewContracts,
} from './trend';

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

/** Which scoped fixture a call wants is in its bound arguments, not its SQL. */
const scopedBy = <T>(binds: unknown[], authority: T, bidder: T, national: T): T =>
  binds.includes('auth:111') ? authority : binds.includes('eik:222') ? bidder : national;

function fake(asOf: string | null = null): FakeD1 {
  return fakeD1([
    { when: 'GROUP BY period', all: SERIES },
    { when: 'COUNT(*) AS total', first: COVERAGE },
    { when: 'SELECT as_of FROM home_totals', first: { as_of: asOf } },
    // getSpendingTrend also fills the sector-filter dropdown; no test here asserts on it.
    { when: 'FROM sector_totals', all: [] },
  ]);
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

function scopedFake(): FakeD1 {
  return fakeD1([
    { when: 'FROM sector_totals', all: [{ division: '45' }] },
    { when: 'SELECT as_of FROM home_totals', first: { as_of: null } },
    {
      when: 'GROUP BY period',
      all: (call) =>
        scopedBy(call.binds, SCOPED_SERIES.authority, SCOPED_SERIES.bidder, SCOPED_SERIES.national),
    },
    {
      when: 'COUNT(*) AS total',
      first: (call) =>
        scopedBy(
          call.binds,
          { dated: 50, total: 60 },
          { dated: 25, total: 30 },
          { dated: 120, total: 140 },
        ),
    },
  ]);
}

describe('getSpendingTrend', () => {
  it('zero-fills gaps so the monthly series is continuous', async () => {
    const { points } = await getSpendingTrend(fake().db, {});
    expect(points).toHaveLength(13); // 2022-01 .. 2023-01 inclusive
    expect(points[0]!.period).toBe('2022-01');
    expect(points.at(-1)!.period).toBe('2023-01');
    expect(points.find((p) => p.period === '2022-02')).toMatchObject({ valueEur: 0, contracts: 0 });
  });

  it('folds months into a per-year summary with year-over-year change', async () => {
    const { years } = await getSpendingTrend(fake().db, {});
    expect(years).toEqual([
      { year: '2022', valueEur: 4000, contracts: 40, yoyPct: null, partial: false },
      { year: '2023', valueEur: 5000, contracts: 50, yoyPct: 0.25, partial: false }, // (5000 - 4000) / 4000
    ]);
  });

  it('marks the as_of period and year partial and suppresses the partial year YoY', async () => {
    const { points, years } = await getSpendingTrend(fake('2023-01-15').db, {});
    expect(points.at(-1)).toMatchObject({ period: '2023-01', partial: true });
    expect(points.find((p) => p.period === '2022-03')).toMatchObject({ partial: false });
    const y2023 = years.find((y) => y.year === '2023')!;
    expect(y2023).toMatchObject({ partial: true, yoyPct: null });
    expect(years.find((y) => y.year === '2022')!.partial).toBe(false);
  });

  it('reports coverage of contracts with a usable signing date', async () => {
    const { coverage, totalValueEur } = await getSpendingTrend(fake().db, {});
    expect(coverage).toEqual({ dated: 80, total: 100, pct: 0.8 });
    expect(totalValueEur).toBe(9000); // 1000 + 3000 + 5000
  });

  it('uses month substr by default and year substr when asked', async () => {
    const month = fake();
    await getSpendingTrend(month.db, {});
    expect(month.sql.some((s) => s.includes('substr(c.signed_at, 1, 7)'))).toBe(true);

    const year = fake();
    await getSpendingTrend(year.db, { granularity: 'year' });
    expect(year.sql.some((s) => s.includes('substr(c.signed_at, 1, 4) AS period'))).toBe(true);
  });

  it('joins tenders only when a sector filter is set', async () => {
    const plain = fake();
    await getSpendingTrend(plain.db, {});
    expect(plain.sql.some((s) => s.includes('JOIN tenders'))).toBe(false);

    const filtered = fake();
    await getSpendingTrend(filtered.db, { sector: '45' });
    expect(filtered.sql.some((s) => s.includes('JOIN tenders t'))).toBe(true);
  });

  it('scopes the trend by authorityId through the tender authority', async () => {
    const national = await getSpendingTrend(scopedFake().db, { granularity: 'year' });
    const calls = scopedFake();
    const scoped = await getSpendingTrend(calls.db, {
      authorityId: 'auth:111',
      granularity: 'year',
    });

    expect(scoped.totalValueEur).toBe(5000);
    expect(scoped.totalValueEur).toBeLessThan(national.totalValueEur);
    expect(scoped.years).toMatchObject([
      { year: '2022', valueEur: 4000, contracts: 40 },
      { year: '2023', valueEur: 1000, contracts: 10 },
    ]);

    const series = calls.calls.find((c) => c.sql.includes('GROUP BY period'))!;
    expect(series.sql).toContain('JOIN tenders t ON t.id = c.tender_id');
    expect(series.sql).toContain('t.authority_id = ?');
    expect(series.binds).toEqual(['2020-01-01', 'auth:111']);
  });

  it('folds monthly rows into a continuous quarterly series (queried at month grain)', async () => {
    const f = fake();
    const { points, granularity } = await getSpendingTrend(f.db, {
      granularity: 'quarter',
    });
    // Quarters come from the monthly substr, not a SQL quarter expression.
    expect(f.sql.some((s) => s.includes('substr(c.signed_at, 1, 7)'))).toBe(true);
    expect(granularity).toBe('quarter');
    expect(points.map((p) => p.period)).toEqual([
      '2022-Q1',
      '2022-Q2',
      '2022-Q3',
      '2022-Q4',
      '2023-Q1',
    ]);
    // 2022-01 + 2022-03 land in the same quarter; the gap quarters are zero-filled.
    expect(points[0]).toMatchObject({ valueEur: 4000, contracts: 40 });
    expect(points[1]).toMatchObject({ valueEur: 0, contracts: 0 });
    expect(points.at(-1)).toMatchObject({ valueEur: 5000, contracts: 50 });
  });

  it('marks the as_of quarter partial', async () => {
    const { points, years } = await getSpendingTrend(fake('2023-01-15').db, {
      granularity: 'quarter',
    });
    expect(points.at(-1)).toMatchObject({ period: '2023-Q1', partial: true });
    expect(points.find((p) => p.period === '2022-Q1')).toMatchObject({ partial: false });
    expect(years.find((y) => y.year === '2023')).toMatchObject({ partial: true, yoyPct: null });
  });

  it('scopes the trend by bidderId through the contract bidder', async () => {
    const national = await getSpendingTrend(scopedFake().db, { granularity: 'year' });
    const calls = scopedFake();
    const scoped = await getSpendingTrend(calls.db, {
      bidderId: 'eik:222',
      granularity: 'year',
    });

    expect(scoped.totalValueEur).toBe(2500);
    expect(scoped.totalValueEur).toBeLessThan(national.totalValueEur);
    expect(scoped.years).toMatchObject([
      { year: '2022', valueEur: 2000, contracts: 20 },
      { year: '2023', valueEur: 500, contracts: 5 },
    ]);

    const series = calls.calls.find((c) => c.sql.includes('GROUP BY period'))!;
    expect(series.sql).toContain('c.bidder_id = ?');
    expect(series.sql).not.toContain('JOIN tenders t');
    expect(series.binds).toEqual(['2020-01-01', 'eik:222']);
  });
});

// ── Contracts overview queries ───────────────────────────────────────────────────────────────────

// Fake D1 that routes each prepared statement by SQL shape and records { sql, args } for assertions.
// `when: []` matches any query — the dispatch on SQL shape happens in the handlers themselves, same
// as the hand-rolled double this replaced, just built through the shared fakeD1() helper (#325).
function overviewDb(handlers: {
  all?: (sql: string, args: unknown[]) => unknown[];
  first?: (sql: string, args: unknown[]) => unknown;
  calls?: QueryCall[];
}): D1Database {
  return fakeD1([
    {
      when: [],
      all: (call) => {
        handlers.calls?.push({ sql: call.sql, args: call.binds });
        return handlers.all?.(call.sql, call.binds) ?? [];
      },
      first: (call) => {
        handlers.calls?.push({ sql: call.sql, args: call.binds });
        return (handlers.first?.(call.sql, call.binds) ?? null) as object | null;
      },
    },
  ]).db;
}

describe('getCpvGroupStats', () => {
  // cnt=101 → floor-rank percentiles: p10 at rn 11, median at rn 51, p90 at rn 91 (matches the SQL's
  // integer division). The rows below stand in for the quantile ladder the query returns.
  const DIST_33600 = [
    { v: 100, name: 'Фармацевтични продукти', rn: 1, cnt: 101 },
    { v: 1000, name: 'Фармацевтични продукти', rn: 11, cnt: 101 },
    { v: 38000, name: 'Фармацевтични продукти', rn: 51, cnt: 101 },
    { v: 200000, name: 'Медицински консумативи', rn: 91, cnt: 101 },
    { v: 900000, name: null, rn: 101, cnt: 101 },
  ];
  const DIST_45000 = [{ v: 5000, name: 'Строителни работи', rn: 1, cnt: 1 }];

  function db(calls: QueryCall[]): D1Database {
    return overviewDb({
      calls,
      all(sql, args) {
        if (sql.includes('GROUP BY grp')) {
          return [
            { grp: '33600', contracts: 101 },
            { grp: '45000', contracts: 1 },
          ];
        }
        if (args[0] === '33600') return DIST_33600;
        if (args[0] === '45000') return DIST_45000;
        return [];
      },
      first(sql) {
        if (sql.includes('COUNT(DISTINCT')) return { n: 2045 };
        return null;
      },
    });
  }

  it('returns top groups with exact floor-rank percentiles from one bounded pass per group', async () => {
    const { groups, totalGroups } = await getCpvGroupStats(db([]), 2);
    expect(totalGroups).toBe(2045);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      group: '33600',
      contracts: 101,
      p10Eur: 1000,
      medianEur: 38000,
      p90Eur: 200000,
      maxEur: 900000,
      name: 'Фармацевтични продукти', // most common description among the sample
    });
    expect(groups[0]!.sampleEur).toEqual([100, 1000, 38000, 200000, 900000]);
    // A single-contract group degenerates to that one value everywhere.
    expect(groups[1]).toMatchObject({
      group: '45000',
      p10Eur: 5000,
      medianEur: 5000,
      p90Eur: 5000,
    });
  });

  it('scans each group through a half-open cpv_code prefix range (indexable)', async () => {
    const calls: QueryCall[] = [];
    await getCpvGroupStats(db(calls), 2);
    const dist = calls.filter((c) => c.sql.includes('ROW_NUMBER() OVER'));
    expect(dist.map((c) => c.args)).toEqual([
      ['33600', '33601'],
      ['45000', '45001'],
    ]);
    expect(dist[0]!.sql).toContain('t.cpv_code >= ? AND t.cpv_code < ?');
    // The distribution query never sorts by anything unindexed and returns only picked ranks.
    expect(dist[0]!.sql).toContain('rn = (cnt - 1) * 5 / 10 + 1');
  });

  it('logs and falls back to the sample minimum when an expected rank is missing from the sample', async () => {
    // A group whose sample is missing rank 1 (a stand-in for a future GROUP_DIST_SQL regression
    // dropping an expected rank) must still return a value — the minimum in the sample — but must
    // not fail silently.
    const brokenDb = overviewDb({
      calls: [],
      all(sql, args) {
        if (sql.includes('GROUP BY grp')) return [{ grp: '45000', contracts: 1 }];
        if (args[0] === '45000') return [{ v: 5000, name: 'x', rn: 2, cnt: 1 }];
        return [];
      },
      first: () => ({ n: 1 }),
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { groups } = await getCpvGroupStats(brokenDb, 1);
    expect(groups[0]).toMatchObject({ medianEur: 5000, p10Eur: 5000, p90Eur: 5000 });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('rank 1 missing'));
    errSpy.mockRestore();
  });
});

describe('getCpvGroupMedians', () => {
  it('returns the lower median per group, dedupes and drops malformed groups', async () => {
    const calls: QueryCall[] = [];
    const db = overviewDb({
      calls,
      first(sql, args) {
        if (!sql.includes('rn = (cnt - 1) * 5 / 10 + 1')) return null;
        if (args[0] === '22112') return { v: 6300, name: ' Училищни учебници ', cnt: 10 };
        if (args[0] === '99999') return { v: 100, name: null, cnt: 3 };
        return null;
      },
    });
    const medians = await getCpvGroupMedians(db, ['22112', '22112', 'bogus', '99999', '4500']);
    expect(medians).toEqual([
      { group: '22112', name: 'Училищни учебници', contracts: 10, medianEur: 6300 },
      { group: '99999', name: null, contracts: 3, medianEur: 100 },
    ]);
    // Two valid unique groups → exactly two median statements; '…9' prefix rolls to the next char.
    const medianCalls = calls.filter((c) => c.sql.includes('rn = (cnt - 1)'));
    expect(medianCalls).toHaveLength(2);
    expect(medianCalls[1]!.args).toEqual(['99999', '9999:']);
  });

  it('is a no-op for an empty group list', async () => {
    expect(await getCpvGroupMedians(overviewDb({}), [])).toEqual([]);
  });
});

describe('listOverviewContracts', () => {
  const ROWS = [
    {
      id: 'c:abc',
      signed_at: '2025-06-01',
      amount_eur: 125000,
      cpv_code: '33600000',
      authority_name: 'УМБАЛ Александровска ЕАД',
      bidder_name: 'Апекс Инженеринг ООД',
      bidder_kind: 'company',
    },
    {
      id: 'c:def',
      signed_at: '2025-05-01',
      amount_eur: 500,
      cpv_code: null,
      authority_name: 'Община Брегово',
      bidder_name: 'Фирма А; Фирма Б',
      bidder_kind: 'consortium',
    },
  ];

  it('maps rows to overview cards (slug, display names, 5-digit group)', async () => {
    const db = overviewDb({ all: () => ROWS });
    const items = await listOverviewContracts(db, {});
    expect(items).toEqual([
      {
        id: 'abc',
        signedAt: '2025-06-01',
        valueEur: 125000,
        authorityName: 'УМБАЛ Александровска ЕАД',
        bidderName: 'Апекс Инженеринг ООД',
        cpvGroup: '33600',
      },
      {
        id: 'def',
        signedAt: '2025-05-01',
        valueEur: 500,
        authorityName: 'Община Брегово',
        bidderName: 'Фирма А и др.', // consortium folded like the rest of the site
        cpvGroup: null,
      },
    ]);
  });

  it('applies year and CPV-group cuts and the value sort, all bounded by LIMIT', async () => {
    const calls: QueryCall[] = [];
    const db = overviewDb({ calls, all: () => [] });
    await listOverviewContracts(db, { year: '2024', cpvGroup: '45233', sort: 'value', limit: 12 });
    const call = calls[0]!;
    expect(call.sql).toContain('substr(c.signed_at, 1, 4) = ?');
    expect(call.sql).toContain('t.cpv_code >= ? AND t.cpv_code < ?');
    expect(call.sql).toContain('ORDER BY c.amount_eur DESC');
    expect(call.args).toEqual(['2020-01-01', '2024', '45233', '45234', 12]);
  });

  it('defaults to newest-first within the trend window on the same value basis', async () => {
    const calls: QueryCall[] = [];
    const db = overviewDb({ calls, all: () => [] });
    await listOverviewContracts(db, {});
    const call = calls[0]!;
    expect(call.sql).toContain('ORDER BY c.signed_at DESC');
    expect(call.sql).toContain('c.amount_eur > 0');
    expect(call.sql).toContain('substr(c.signed_at, 1, 4) GLOB');
    expect(call.args).toEqual(['2020-01-01', 24]);
  });
});
