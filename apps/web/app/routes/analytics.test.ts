import { afterEach, describe, expect, it, vi } from 'vitest';

// Loader test for /analytics. @sigma/db is mocked so the loader runs without a real D1 — the five
// query functions are the trust boundary; this exercises the loader's fan-out and its derivation of
// the trend/peak/opaque headline via the (separately unit-tested) analytics-stats helpers.
const q = vi.hoisted(() => ({
  getOverrunsHeadline: vi.fn(),
  getFlowsHeadline: vi.fn(),
  getRegionHeadline: vi.fn(),
  getSpendingTrend: vi.fn(),
  getOpaqueShareByYear: vi.fn(),
  getDb: vi.fn((env: { DB: unknown }) => env.DB),
}));
vi.mock('@sigma/db', () => q);

import { loader } from './analytics';

const DB = {};
const context = { cloudflare: { env: { DB } } };

afterEach(() => {
  for (const fn of Object.values(q)) fn.mockReset();
});

describe('loader (/analytics)', () => {
  it('fans out five bounded reads and derives peak/YoY/opaque from real trend points', async () => {
    q.getOverrunsHeadline.mockResolvedValue({ totalOverrunEur: 100, count: 1 });
    q.getFlowsHeadline.mockResolvedValue({ totalEur: 200 });
    q.getRegionHeadline.mockResolvedValue({ regions: 28 });
    q.getSpendingTrend.mockResolvedValue({
      points: [
        { period: '2021-01', valueEur: 100 },
        { period: '2022-06', valueEur: 500 },
        { period: '2022-01', valueEur: 200 },
      ],
    });
    q.getOpaqueShareByYear.mockResolvedValue([
      { year: '2021', valueEur: 1000, singleOfferValueEur: 100 },
      { year: '2022', valueEur: 2000, singleOfferValueEur: 500 },
    ]);

    const res = await loader({ context } as never);

    expect(q.getOverrunsHeadline).toHaveBeenCalledWith(DB);
    expect(q.getFlowsHeadline).toHaveBeenCalledWith(DB);
    expect(q.getRegionHeadline).toHaveBeenCalledWith(DB);
    expect(q.getSpendingTrend).toHaveBeenCalledWith(
      DB,
      { funding: 'all', granularity: 'month' },
      { includeSectors: false },
    );
    expect(q.getOpaqueShareByYear).toHaveBeenCalledWith(DB);

    expect(res.overruns).toEqual({ totalOverrunEur: 100, count: 1 });
    expect(res.flows).toEqual({ totalEur: 200 });
    expect(res.region).toEqual({ regions: 28 });
    // Peak point is the max-value period among the fetched trend points, not fetched separately.
    expect(res.trend.peakPeriod).toBe('2022-06');
    // Three months of data is < 2 complete years: an explicit no-data state, never a fake „+0%/год".
    expect(res.trend.avgYoy).toBeNull();
    // The opaque headline is really derived from the real OpaqueShareYear shape (10% → 25%).
    expect(res.opaque).toMatchObject({ latestYear: '2022', firstYear: '2021' });
    expect(res.opaque!.latestShare).toBeCloseTo(0.25, 5);
    expect(res.opaque!.firstShare).toBeCloseTo(0.1, 5);
    expect(res.opaque!.ppChange).toBeCloseTo(0.15, 5);
  });

  it('reports a numeric YoY once two complete monthly years are on record', async () => {
    q.getOverrunsHeadline.mockResolvedValue({ totalOverrunEur: 0, count: 0 });
    q.getFlowsHeadline.mockResolvedValue({ totalEur: 0 });
    q.getRegionHeadline.mockResolvedValue({ regions: 0 });
    const yr = (y: number, v: number) =>
      Array.from({ length: 12 }, (_, i) => ({
        period: `${y}-${String(i + 1).padStart(2, '0')}`,
        valueEur: v,
        contracts: 1,
        partial: false,
      }));
    q.getSpendingTrend.mockResolvedValue({ points: [...yr(2022, 100), ...yr(2023, 120)] });
    q.getOpaqueShareByYear.mockResolvedValue([]);

    const res = await loader({ context } as never);

    expect(res.trend.avgYoy).toBeCloseTo(0.2, 5);
  });

  it('never fabricates a peak period when there are no trend points', async () => {
    q.getOverrunsHeadline.mockResolvedValue({ totalOverrunEur: 0, count: 0 });
    q.getFlowsHeadline.mockResolvedValue({ totalEur: 0 });
    q.getRegionHeadline.mockResolvedValue({ regions: 0 });
    q.getSpendingTrend.mockResolvedValue({ points: [] });
    q.getOpaqueShareByYear.mockResolvedValue([]);

    const res = await loader({ context } as never);

    expect(res.trend.peakPeriod).toBeNull();
  });
});
