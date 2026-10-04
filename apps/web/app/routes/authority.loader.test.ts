import { afterEach, describe, expect, it, vi } from 'vitest';

// The authority loader only gathers reads; the query layer is mocked so the test pins which reads it
// makes and when it answers 404, without D1.
const q = vi.hoisted(() => ({
  authorityIdFromSlug: vi.fn((slug: string) => `auth:${slug}`),
  getAuthority: vi.fn(),
  getAuthorityConflictSummary: vi.fn(async () => ({ companies: 0, ownCompanies: 0 })),
  getAuthoritySupplierTies: vi.fn(async () => ({ center: null, nodes: [], edges: [], omitted: 0 })),
  getSpendingTrend: vi.fn(async () => ({ points: [], years: [] })),
  competitionTotals: vi.fn(async () => ({ contracts: 0 })),
  procedureCompetition: vi.fn(async () => ({ classifiedContracts: 0 })),
  getPartialStartYear: vi.fn(async () => null),
  getDb: vi.fn((env: { DB: unknown }) => env.DB),
}));
vi.mock('@sigma/db', () => q);

import { loader } from './authority';

const DB = {
  prepare: vi.fn(() => ({
    first: vi.fn(async () => ({ as_of: '2026-09-01', refreshed_at: '2026-09-02' })),
  })),
};
const context = { cloudflare: { env: { DB } } };
const call = (eik: string | undefined) => loader({ params: { eik }, context } as never);

afterEach(() => {
  vi.clearAllMocks();
});

describe('authority loader', () => {
  it.each([undefined, '', '   '])('404s an absent slug (%s) before reading D1', async (eik) => {
    await expect(call(eik)).rejects.toMatchObject({ status: 404 });
    expect(q.getDb).not.toHaveBeenCalled();
  });

  it('404s an authority the database does not know', async () => {
    q.getAuthority.mockResolvedValue(null);
    await expect(call('000000000')).rejects.toMatchObject({ status: 404 });
    expect(q.getAuthority).toHaveBeenCalledWith(DB, 'auth:000000000');
  });

  it('reads the profile, its competition figures and its declared-interest summary', async () => {
    q.getAuthority.mockResolvedValue({ slug: '000000000', name: 'Тестова институция' });
    const data = (await call('000000000')) as { authority: { name: string }; tieLayout: unknown };

    expect(data.authority.name).toBe('Тестова институция');
    expect(data.tieLayout).toBeNull();
    expect(q.competitionTotals).toHaveBeenCalledWith(DB, { authorityId: 'auth:000000000' });
    expect(q.procedureCompetition).toHaveBeenCalledWith(DB, { authorityId: 'auth:000000000' });
    expect(q.getAuthorityConflictSummary).toHaveBeenCalledWith(DB, 'auth:000000000');
  });
});
