import { describe, expect, it } from 'vitest';
import { fakeD1, type FakeD1 } from '@sigma/test-support';
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

describe('getSpendingTrend — zero-spend prior year and empty coverage', () => {
  it('nulls YoY against a zero prior year and reports zero coverage when nothing is dated', async () => {
    // 2023 is fully zero-filled between the two endpoints → 2024 YoY is measured against 0 → null.
    const custom = fakeD1([
      {
        when: 'GROUP BY period',
        all: [
          { period: '2022-01', value_eur: 1000, contracts: 10 },
          { period: '2024-01', value_eur: 2000, contracts: 20 },
        ],
      },
      { when: 'COUNT(*) AS total', first: { dated: 0, total: 0 } },
      { when: 'SELECT as_of FROM home_totals', first: { as_of: null } },
      { when: 'FROM sector_totals', all: [] },
    ]);
    const { years, coverage } = await getSpendingTrend(custom.db, {});
    const byYear = new Map(years.map((y) => [y.year, y]));
    expect(byYear.get('2023')).toMatchObject({ valueEur: 0, yoyPct: -1 }); // (0 - 1000)/1000
    expect(byYear.get('2024')!.yoyPct).toBeNull(); // prev year is 0 → guarded
    expect(coverage).toEqual({ dated: 0, total: 0, pct: 0 }); // total 0 → pct 0, no divide-by-zero
  });
});

describe('getSpendingTrend — funding scope, sectors toggle, empty inputs', () => {
  it('scopes the series by EU funding', async () => {
    const cap = fake();
    await getSpendingTrend(cap.db, { funding: 'eu' });
    expect(cap.sql.some((s) => s.includes('c.eu_funded = 1'))).toBe(true);
  });

  it('scopes the series by national funding', async () => {
    const cap = fake();
    await getSpendingTrend(cap.db, { funding: 'national' });
    expect(cap.sql.some((s) => s.includes('c.eu_funded IS NULL OR c.eu_funded = 0'))).toBe(true);
  });

  it('skips the sector options when includeSectors is false', async () => {
    const data = await getSpendingTrend(fake().db, {}, { includeSectors: false });
    expect(data.sectors).toEqual([]);
  });

  it('resolves sector options from sector_totals when includeSectors defaults on', async () => {
    // scopedFake() answers sector_totals with { division: '45' }; the default (includeSectors) path
    // must resolve it to a SectorRef. Asserting the resolved code guards the true branch against a
    // mutation that always returns [] — which the includeSectors:false case cannot detect.
    const data = await getSpendingTrend(scopedFake().db, {});
    expect(data.sectors.map((s) => s.code)).toEqual(['45']);
  });

  it('returns empty points and zero coverage when the series and coverage rows are absent', async () => {
    const empty = fakeD1([
      { when: 'GROUP BY period', all: [] }, // no series rows → the points loop is skipped
      { when: 'COUNT(*) AS total', first: null }, // coverageRow null → dated/total fall back to 0
      { when: 'SELECT as_of FROM home_totals', first: { as_of: null } },
      { when: 'FROM sector_totals', all: [] },
    ]);
    const data = await getSpendingTrend(empty.db, {});
    expect(data.points).toEqual([]);
    expect(data.coverage).toEqual({ dated: 0, total: 0, pct: 0 });
  });
});
