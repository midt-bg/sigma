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
    q.getOpaqueShareByYear.mockResolvedValue([{ year: 2022, sharePct: 12.5 }]);

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
    expect(typeof res.trend.avgYoy).toBe('number');
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
