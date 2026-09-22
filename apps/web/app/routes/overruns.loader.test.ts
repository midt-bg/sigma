// Loader tests for /overruns. @sigma/db is mocked so the loader's own logic (sort param validation,
// the single annex fetch keyed off the leaderboard ids, grouping for the inspector) runs without D1.
import { afterEach, describe, expect, it, vi } from 'vitest';

const q = vi.hoisted(() => ({
  getDb: vi.fn((env: { DB: unknown }) => env.DB),
  getOverrunsAnalytics: vi.fn(),
  getOverrunAnnexes: vi.fn(),
}));
vi.mock('@sigma/db', () => q);

import { loader } from './overruns';

const DB = {};
const call = (search: string) =>
  loader({
    request: new Request(`https://sigma.test/overruns${search}`),
    context: { cloudflare: { env: { DB } } },
  } as never);

const analytics = (contractIds: string[]) => ({
  rows: contractIds.map((contractId) => ({ contractId })),
  corpus: {},
  byAuthority: [],
  bySector: [],
});

afterEach(() => {
  for (const fn of Object.values(q)) fn.mockReset();
  q.getDb.mockImplementation((env: { DB: unknown }) => env.DB);
});

describe('/overruns loader', () => {
  it('defaults to the absolute ordering and only honours by=percent as the alternative', async () => {
    q.getOverrunsAnalytics.mockResolvedValue(analytics([]));
    q.getOverrunAnnexes.mockResolvedValue([]);
    for (const [qs, expected] of [
      ['', 'absolute'],
      ['?by=percent', 'percent'],
      ['?by=absolute', 'absolute'],
      ['?by=%27%3B%20DROP', 'absolute'],
    ] as const) {
      const data = await call(qs);
      expect(data.by).toBe(expected);
      expect(q.getOverrunsAnalytics).toHaveBeenLastCalledWith(DB, { by: expected });
    }
  });

  it('fetches annex history once, for exactly the leaderboard contracts, and groups it per contract', async () => {
    q.getOverrunsAnalytics.mockResolvedValue(analytics(['c1', 'c2']));
    q.getOverrunAnnexes.mockResolvedValue([
      { contractId: 'c1', date: '2020-01-01', reason: 'a', deltaEur: 1 },
      { contractId: 'c1', date: '2020-02-01', reason: null, deltaEur: null },
      { contractId: 'c2', date: null, reason: 'b', deltaEur: -5 },
    ]);

    const data = await call('');

    expect(q.getOverrunAnnexes).toHaveBeenCalledTimes(1);
    expect(q.getOverrunAnnexes).toHaveBeenCalledWith(DB, ['c1', 'c2']);
    expect(data.annexesByContract).toEqual({
      c1: [
        { seq: 1, date: '2020-01-01', reason: 'a', deltaEur: 1 },
        { seq: 2, date: '2020-02-01', reason: null, deltaEur: null },
      ],
      c2: [{ seq: 1, date: null, reason: 'b', deltaEur: -5 }],
    });
  });

  it('passes an empty leaderboard through without inventing annex groups', async () => {
    q.getOverrunsAnalytics.mockResolvedValue(analytics([]));
    q.getOverrunAnnexes.mockResolvedValue([]);
    expect((await call('')).annexesByContract).toEqual({});
  });
});
