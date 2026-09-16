import { describe, expect, it, vi } from 'vitest';

// The /conflicts loader reads ?page from the URL, so a value that is not a positive whole number must land on
// the first page rather than an empty slice (or a NaN offset). @sigma/db is mocked: 150 people, two pages.
const q = vi.hoisted(() => ({
  getDb: vi.fn((env: { DB: unknown }) => env.DB),
  getRelatedPersonRows: vi.fn(async () =>
    Array.from({ length: 150 }, (_, i) => ({
      official: `Лице ${i}`,
      officialSlug: `s${String(i).padStart(3, '0')}`,
      personIdentity: `p${i}`,
      institution: null,
      position: null,
      companyCount: 1,
      soleCompany: null,
      contractCount: 1,
      contractValueEur: 1_000,
      contemporaneousValueEur: 150 - i,
      stakeKind: 'self' as const,
      ownInstitution: false,
      hasContemporaneous: true,
      declaredOffices: [],
    })),
  ),
  getAuthorityName: vi.fn(),
  authorityIdFromSlug: vi.fn(),
}));
vi.mock('@sigma/db', () => q);

import { loader } from './conflicts';

const load = async (qs: string) =>
  (
    (await loader({
      request: new Request(`https://sigma.test/conflicts${qs}`),
      context: { cloudflare: { env: { DB: {} } } },
    } as never)) as {
      data: { page: number; pageCount: number; pageRows: { personIdentity: string }[] };
    }
  ).data;

describe('leaderboard loader — the page number', () => {
  it.each(['0', '-2', '1.5', 'abc', '1e400'])(
    'serves the first page for ?page=%s',
    async (page) => {
      const res = await load(`?page=${page}`);
      expect(res.page).toBe(1);
      expect(res.pageCount).toBe(2);
      expect(res.pageRows).toHaveLength(100);
      expect(res.pageRows[0]!.personIdentity).toBe('p0');
    },
  );

  it('serves the last page for a number past the end', async () => {
    const res = await load('?page=9');
    expect(res.page).toBe(2);
    expect(res.pageRows.map((r) => r.personIdentity)).toHaveLength(50);
    expect(res.pageRows[0]!.personIdentity).toBe('p100');
  });
});
