// Loader tests for /trends. @sigma/db is mocked so the loader's own logic — param validation, the
// step→granularity mapping, exact truncation detection and the median-baseline fan-out — runs
// without a real D1 database.
import { afterEach, describe, expect, it, vi } from 'vitest';

const q = vi.hoisted(() => ({
  getDb: vi.fn((env: { DB: unknown }) => env.DB),
  getSpendingTrend: vi.fn(),
  getCpvGroupStats: vi.fn(),
  getCpvGroupMedians: vi.fn(),
  listOverviewContracts: vi.fn(),
}));
vi.mock('@sigma/db', () => q);

import { loader } from './trends';

const DB = {};
const call = (search: string) =>
  loader({
    request: new Request(`https://sigma.test/trends${search}`),
    context: { cloudflare: { env: { DB } } },
  } as never);

const contractIn = (id: string, cpvGroup: string | null) => ({
  id,
  signedAt: '2024-01-01',
  valueEur: 10,
  authorityName: 'A',
  bidderName: 'B',
  cpvGroup,
});

const knownGroup = {
  group: '11111',
  name: 'known',
  contracts: 5,
  medianEur: 100,
  p10Eur: 10,
  p90Eur: 200,
  maxEur: 300,
  sampleEur: [],
};

function stubDb(contracts: unknown[] = [], groups: unknown[] = []) {
  q.getSpendingTrend.mockResolvedValue({ points: [], years: [] });
  q.getCpvGroupStats.mockResolvedValue({ groups, totalGroups: groups.length });
  q.getCpvGroupMedians.mockResolvedValue([]);
  q.listOverviewContracts.mockResolvedValue(contracts);
}

afterEach(() => {
  for (const fn of Object.values(q)) fn.mockReset();
  q.getDb.mockImplementation((env: { DB: unknown }) => env.DB);
});

describe('/trends loader — param validation', () => {
  it('defaults to the time lens, quarterly step, date sort and no filters', async () => {
    stubDb();
    expect(await call('')).toMatchObject({
      angle: 'time',
      step: 'q',
      sort: 'date',
      cpvSort: 'n',
      year: null,
      cpvSel: [],
      cur: false,
    });
    expect(q.getSpendingTrend).toHaveBeenCalledWith(
      DB,
      { granularity: 'quarter', cpvGroups: [], includeCurrent: false, year: null },
      { includeSectors: false },
    );
  });

  it('falls back to the safe default for every unrecognised or hostile param', async () => {
    stubDb();
    const data = await call('?angle=evil&step=x&sort=random&cpvSort=zzz&year=1999&cur=yes');
    expect(data).toMatchObject({
      angle: 'time',
      step: 'q',
      sort: 'date',
      cpvSort: 'n',
      year: null,
      cur: false,
    });
  });

  it('accepts each documented value, including ?cur=1 as the only opt-in', async () => {
    stubDb();
    const data = await call('?angle=cpv&step=m&sort=value&cpvSort=med&year=2024&cur=1');
    expect(data).toMatchObject({
      angle: 'cpv',
      step: 'm',
      sort: 'value',
      cpvSort: 'med',
      year: '2024',
      cur: true,
    });
    expect(q.getSpendingTrend).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ granularity: 'month', includeCurrent: true, year: '2024' }),
      expect.anything(),
    );
  });

  it('maps the step toggle to the chart granularity, but pins the cross lens to quarters', async () => {
    stubDb();
    await call('?step=y');
    expect(q.getSpendingTrend).toHaveBeenLastCalledWith(
      DB,
      expect.objectContaining({ granularity: 'year' }),
      expect.anything(),
    );
    await call('?angle=cross&step=m');
    expect(q.getSpendingTrend).toHaveBeenLastCalledWith(
      DB,
      expect.objectContaining({ granularity: 'quarter' }),
      expect.anything(),
    );
  });

  it('scopes both the trend and the list to the validated cpv selection', async () => {
    stubDb();
    const data = await call('?cpv=45233&cpv=bogus&cpv=33600');
    // Malformed codes are dropped; the same validated set scopes the chart and the list.
    expect([...data.cpvSel].sort()).toEqual(['33600', '45233']);
    expect(q.getSpendingTrend).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ cpvGroups: data.cpvSel }),
      expect.anything(),
    );
    expect(q.listOverviewContracts).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ cpvGroups: data.cpvSel }),
    );
  });
});

describe('/trends loader — list truncation', () => {
  it('fetches one extra row and only reports a cut when that extra row exists', async () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => contractIn(`c${i}`, null));

    stubDb(rows(25));
    const cut = await call('');
    expect(q.listOverviewContracts).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ limit: 25 }),
    );
    expect(cut.contracts).toHaveLength(24);
    expect(cut.contractsTruncated).toBe(true);

    stubDb(rows(24));
    const exact = await call('');
    expect(exact.contracts).toHaveLength(24);
    expect(exact.contractsTruncated).toBe(false);
  });
});

describe('/trends loader — median baselines', () => {
  it('asks only for card groups and selected groups the top-N stats lack, once each', async () => {
    stubDb(
      [
        contractIn('c1', '22222'),
        contractIn('c2', '22222'),
        contractIn('c3', '11111'),
        contractIn('c4', null),
      ],
      [knownGroup],
    );
    await call('?cpv=33333&cpv=11111');
    const [, requested] = q.getCpvGroupMedians.mock.calls[0]!;
    expect([...requested].sort()).toEqual(['22222', '33333']);
  });

  it('skips the medians query entirely when every group is already known', async () => {
    stubDb([contractIn('c1', '11111')], [knownGroup]);
    const data = await call('?cpv=11111');
    expect(q.getCpvGroupMedians).not.toHaveBeenCalled();
    expect(data.medians).toEqual([]);
  });
});
