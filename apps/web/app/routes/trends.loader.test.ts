import { afterEach, describe, expect, it, vi } from 'vitest';

// Loader test for /overview (trends.tsx). @sigma/db is mocked so the loader runs without a real D1 —
// this exercises angle/step/sort parsing, the CPV multi-select facet, the "+1 row" truncation
// contract with paginateContracts, and the missing-group median backfill.
const q = vi.hoisted(() => ({
  getCpvGroupMedians: vi.fn(),
  getCpvGroupStats: vi.fn(),
  getDb: vi.fn((env: { DB: unknown }) => env.DB),
  getSpendingTrend: vi.fn(),
  listOverviewContracts: vi.fn(),
}));
vi.mock('@sigma/db', () => q);

import { CONTRACT_CARD_LIMIT, loader } from './trends';

const DB = {};
const context = { cloudflare: { env: { DB } } };
const call = (searchParams: string) =>
  loader({
    request: new Request(`https://sigma.local/overview${searchParams}`),
    context,
  } as never);

afterEach(() => {
  for (const fn of Object.values(q)) fn.mockReset();
});

describe('loader (trends.tsx / overview)', () => {
  it('defaults to the time angle, quarter step, and requests one extra row for truncation detection', async () => {
    q.getSpendingTrend.mockResolvedValue({ points: [] });
    q.getCpvGroupStats.mockResolvedValue({ groups: [] });
    q.listOverviewContracts.mockResolvedValue([{ cpvGroup: null }]);
    q.getCpvGroupMedians.mockResolvedValue([]);

    const res = await call('');

    expect(res.angle).toBe('time');
    expect(res.step).toBe('q');
    expect(q.getSpendingTrend).toHaveBeenCalledWith(
      DB,
      { granularity: 'quarter', cpvGroups: [], includeCurrent: false },
      { includeSectors: false },
    );
    expect(q.listOverviewContracts).toHaveBeenCalledWith(DB, {
      year: null,
      cpvGroups: [],
      sort: 'date',
      limit: CONTRACT_CARD_LIMIT + 1,
    });
    expect(res.truncated).toBe(false);
    expect(res.contracts).toHaveLength(1);
  });

  it('always uses quarter granularity for the cross lens, regardless of the step param', async () => {
    q.getSpendingTrend.mockResolvedValue({ points: [] });
    q.getCpvGroupStats.mockResolvedValue({ groups: [] });
    q.listOverviewContracts.mockResolvedValue([]);
    q.getCpvGroupMedians.mockResolvedValue([]);

    const res = await call('?angle=cross&step=y');

    expect(res.angle).toBe('cross');
    expect(q.getSpendingTrend).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ granularity: 'quarter' }),
      { includeSectors: false },
    );
  });

  it('slices the extra probe row off and flags truncation when more rows exist than the card limit', async () => {
    const rows = Array.from({ length: CONTRACT_CARD_LIMIT + 1 }, (_, i) => ({ cpvGroup: null, i }));
    q.getSpendingTrend.mockResolvedValue({ points: [] });
    q.getCpvGroupStats.mockResolvedValue({ groups: [] });
    q.listOverviewContracts.mockResolvedValue(rows);
    q.getCpvGroupMedians.mockResolvedValue([]);

    const res = await call('');

    expect(res.truncated).toBe(true);
    expect(res.contracts).toHaveLength(CONTRACT_CARD_LIMIT);
  });

  it('backfills medians only for CPV groups missing from the top-N stats', async () => {
    q.getSpendingTrend.mockResolvedValue({ points: [] });
    q.getCpvGroupStats.mockResolvedValue({ groups: [{ group: '45000' }] });
    q.listOverviewContracts.mockResolvedValue([{ cpvGroup: '45000' }, { cpvGroup: '33600' }]);
    q.getCpvGroupMedians.mockResolvedValue([]);

    await call('');

    expect(q.getCpvGroupMedians).toHaveBeenCalledWith(DB, ['33600']);
  });

  it('rejects a malformed ?year and never forwards it to the query layer', async () => {
    q.getSpendingTrend.mockResolvedValue({ points: [] });
    q.getCpvGroupStats.mockResolvedValue({ groups: [] });
    q.listOverviewContracts.mockResolvedValue([]);
    q.getCpvGroupMedians.mockResolvedValue([]);

    const res = await call('?year=abcd');

    expect(res.year).toBeNull();
    expect(q.listOverviewContracts).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ year: null }),
    );
  });
});
