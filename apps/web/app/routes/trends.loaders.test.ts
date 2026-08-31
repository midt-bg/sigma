import { afterEach, describe, expect, it, vi } from 'vitest';

// Loader-level test for /trends' angle/year scoping. @sigma/db is mocked so the loader runs
// without a real D1 — the query functions are the trust boundary the loader sits on top of.
const q = vi.hoisted(() => ({
  getSpendingTrend: vi.fn(),
  getCpvGroupStats: vi.fn(),
  getCpvGroupMedians: vi.fn(),
  listOverviewContracts: vi.fn(),
  getDb: vi.fn((env: { DB: unknown }) => env.DB),
}));
vi.mock('@sigma/db', () => q);

import { loader } from './trends';

const DB = {};
const context = { cloudflare: { env: { DB } } };
const call = (search: string) =>
  loader({
    request: new Request(`https://sigma.test/trends${search}`),
    context,
  } as never);

const EMPTY_TREND = {
  points: [],
  years: [],
  granularity: 'quarter',
  totalValueEur: 0,
  coverage: { dated: 0, total: 0 },
  sectors: [],
};

afterEach(() => {
  for (const fn of Object.values(q)) fn.mockReset();
});

describe('trends loader — includeCurrent scope (#171 review)', () => {
  it('honors ?cur=1 on the time angle (the only lens with a visible toggle)', async () => {
    q.getSpendingTrend.mockResolvedValue(EMPTY_TREND);
    q.getCpvGroupStats.mockResolvedValue({ groups: [], totalGroups: 0 });
    q.getCpvGroupMedians.mockResolvedValue([]);
    q.listOverviewContracts.mockResolvedValue([]);

    const data = await call('?cur=1');

    expect(data.cur).toBe(true);
    expect(q.getSpendingTrend).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ includeCurrent: true }),
      expect.anything(),
    );
  });

  it('ignores ?cur=1 on angles with no visible toggle for it (cpv, cross)', async () => {
    q.getSpendingTrend.mockResolvedValue(EMPTY_TREND);
    q.getCpvGroupStats.mockResolvedValue({ groups: [], totalGroups: 0 });
    q.getCpvGroupMedians.mockResolvedValue([]);
    q.listOverviewContracts.mockResolvedValue([]);

    for (const angle of ['cpv', 'cross']) {
      const data = await call(`?angle=${angle}&cur=1`);
      expect(data.cur).toBe(false);
      expect(q.getSpendingTrend).toHaveBeenLastCalledWith(
        DB,
        expect.objectContaining({ includeCurrent: false }),
        expect.anything(),
      );
    }
  });
});

describe('trends loader — year scope (#171 review)', () => {
  it('narrows listOverviewContracts by year but leaves getSpendingTrend corpus-wide', async () => {
    q.getSpendingTrend.mockResolvedValue(EMPTY_TREND);
    q.getCpvGroupStats.mockResolvedValue({ groups: [], totalGroups: 0 });
    q.getCpvGroupMedians.mockResolvedValue([]);
    q.listOverviewContracts.mockResolvedValue([]);

    const data = await call('?year=2024');

    expect(data.year).toBe('2024');
    expect(q.listOverviewContracts).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ year: '2024' }),
    );
    // getSpendingTrend has no year param at all — the loader passes it none, by design (see the
    // "Обобщението и графиката обхващат целия период" note rendered on the page when year is set).
    const [, trendParams] = q.getSpendingTrend.mock.calls[0]!;
    expect(trendParams).not.toHaveProperty('year');
  });
});
