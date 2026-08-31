// Loader tests for /trends. Mocks @sigma/db so the loader's own param-resolution and
// query-fan-out logic (angle/step→granularity, the `g` back-compat, year validation, and the
// missing-cohort dedupe) is exercised without a real D1 database.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CpvGroupStat, OverviewContract, TrendData } from '@sigma/api-contract';

const getSpendingTrend = vi.fn<(...args: unknown[]) => Promise<TrendData>>();
const getCpvGroupStats =
  vi.fn<(...args: unknown[]) => Promise<{ totalGroups: number; groups: CpvGroupStat[] }>>();
const getCpvGroupMedians = vi.fn<(...args: unknown[]) => Promise<unknown[]>>();
const listOverviewContracts = vi.fn<(...args: unknown[]) => Promise<OverviewContract[]>>();

vi.mock('@sigma/db', () => ({
  getDb: () => ({}),
  getSpendingTrend: (...args: unknown[]) => getSpendingTrend(...args),
  getCpvGroupStats: (...args: unknown[]) => getCpvGroupStats(...args),
  getCpvGroupMedians: (...args: unknown[]) => getCpvGroupMedians(...args),
  listOverviewContracts: (...args: unknown[]) => listOverviewContracts(...args),
}));

const { loader } = await import('./trends');

const emptyTrend: TrendData = {
  granularity: 'month',
  points: [],
  years: [],
  sectors: [],
  totalValueEur: 0,
  coverage: { dated: 0, total: 0, pct: 0 },
  scope: { sector: null, funding: 'all', granularity: 'month' },
};

function call(qs: string) {
  const ctx = { cloudflare: { env: {} } } as never;
  return loader({ request: new Request(`http://local/trends${qs}`), context: ctx } as never);
}

beforeEach(() => {
  getSpendingTrend.mockReset().mockResolvedValue(emptyTrend);
  getCpvGroupStats.mockReset().mockResolvedValue({ totalGroups: 0, groups: [] });
  getCpvGroupMedians.mockReset().mockResolvedValue([]);
  listOverviewContracts.mockReset().mockResolvedValue([]);
});

describe('/trends loader — param resolution', () => {
  it('defaults to the time lens, quarterly step, date sort, no year/cpv filter', async () => {
    const data = await call('');
    expect(data).toMatchObject({
      angle: 'time',
      step: 'q',
      sort: 'date',
      cpvSort: 'n',
      year: null,
      cpvSel: [],
      cur: false,
    });
    expect(getSpendingTrend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ granularity: 'quarter', includeCurrent: false }),
      expect.anything(),
    );
  });

  it('the cross lens always queries quarterly, regardless of the step toggle', async () => {
    await call('?angle=cross&step=y');
    expect(getSpendingTrend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ granularity: 'quarter' }),
      expect.anything(),
    );
  });

  it('the time lens follows the step toggle for month/year', async () => {
    await call('?step=m');
    expect(getSpendingTrend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ granularity: 'month' }),
      expect.anything(),
    );
    await call('?step=y');
    expect(getSpendingTrend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ granularity: 'year' }),
      expect.anything(),
    );
  });

  it('falls back to the retired `g` param when `step` is absent (#197 back-compat)', async () => {
    const data = await call('?g=year');
    expect(data.step).toBe('y');
    expect(getSpendingTrend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ granularity: 'year' }),
      expect.anything(),
    );
  });

  it('prefers `step` over `g` when both are present', async () => {
    const data = await call('?g=year&step=m');
    expect(data.step).toBe('m');
    expect(getSpendingTrend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ granularity: 'month' }),
      expect.anything(),
    );
  });

  it('opts into the current partial period only for exactly ?cur=1', async () => {
    await call('?cur=1');
    expect(getSpendingTrend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ includeCurrent: true }),
      expect.anything(),
    );
    await call('?cur=true');
    expect(getSpendingTrend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ includeCurrent: false }),
      expect.anything(),
    );
  });

  it('accepts a well-formed 20xx year and rejects everything else', async () => {
    expect((await call('?year=2024')).year).toBe('2024');
    expect((await call('?year=1999')).year).toBeNull();
    expect((await call('?year=abcd')).year).toBeNull();
  });
});

describe('/trends loader — median cohort dedupe', () => {
  it('requests medians only for cpv groups missing from the top-N stats, deduped', async () => {
    getCpvGroupStats.mockResolvedValue({
      totalGroups: 1,
      groups: [
        {
          group: '11111',
          name: 'known',
          contracts: 5,
          medianEur: 100,
          p10Eur: 10,
          p90Eur: 200,
          maxEur: 300,
          sampleEur: [],
        },
      ],
    });
    listOverviewContracts.mockResolvedValue([
      {
        id: 'c1',
        signedAt: '2024-01-01',
        valueEur: 10,
        authorityName: 'A',
        bidderName: 'B',
        cpvGroup: '22222',
      },
      {
        id: 'c2',
        signedAt: '2024-01-02',
        valueEur: 20,
        authorityName: 'A',
        bidderName: 'B',
        cpvGroup: '22222',
      },
      {
        id: 'c3',
        signedAt: '2024-01-03',
        valueEur: 30,
        authorityName: 'A',
        bidderName: 'B',
        cpvGroup: '11111',
      },
      {
        id: 'c4',
        signedAt: '2024-01-04',
        valueEur: 40,
        authorityName: 'A',
        bidderName: 'B',
        cpvGroup: null,
      },
    ]);
    await call('');
    expect(getCpvGroupMedians).toHaveBeenCalledWith(expect.anything(), ['22222']);
  });
});
