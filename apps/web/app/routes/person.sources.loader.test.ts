import { afterEach, describe, expect, it, vi } from 'vitest';

// The /persons/:id loader around the profile read: a missing :id is a 404 before anything is read, and when
// the register's records do not combine into a profile, the source records are served — noindexed like the
// profile — rather than a 404. The profile read itself is mocked; it has its own tests.
const HASH = 'b'.repeat(64);
const q = vi.hoisted(() => ({
  getDb: vi.fn((env: { DB: unknown }) => env.DB),
  getRegistrySourceCompanies: vi.fn(),
  registryPersonIdFromSlug: vi.fn((slug: string) => (/^[0-9a-f]{64}$/.test(slug) ? slug : null)),
  // Not a declarant's id either — so the request cannot be served under any identity.
  personIdFromSlug: vi.fn(() => null),
}));
const server = vi.hoisted(() => ({ loadPersonProfile: vi.fn() }));
vi.mock('@sigma/db', () => q);
vi.mock('../lib/person-profile.server', () => server);

import { loader } from './person';

const DB = {};
type Loaded = { data: unknown; init: { headers: Record<string, string> } };
const call = (params: { id?: string }) =>
  (loader as (a: unknown) => Promise<Loaded>)({
    params,
    request: new Request(`http://localhost:5173/persons/${params.id ?? ''}?company=111111111`),
    context: { cloudflare: { env: { DB } } },
  });

async function expect404(promise: Promise<unknown>) {
  const thrown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(thrown).toBeInstanceOf(Response);
  expect((thrown as Response).status).toBe(404);
}

afterEach(() => vi.clearAllMocks());

describe('person loader — around the profile read', () => {
  it('404s a request without an :id before any read', async () => {
    await expect404(call({}));
    expect(q.registryPersonIdFromSlug).toHaveBeenCalledWith('');
    expect(server.loadPersonProfile).not.toHaveBeenCalled();
  });

  it('serves the profile with the request’s filters, noindexed', async () => {
    const profile = { name: 'АННА ПЕТРОВА' };
    server.loadPersonProfile.mockResolvedValue(profile);
    const res = await call({ id: HASH });
    expect(res.data).toBe(profile);
    expect(res.init.headers).toEqual({ 'X-Robots-Tag': 'noindex' });
    const [db, input] = server.loadPersonProfile.mock.calls[0]!;
    expect(db).toBe(DB);
    expect(input.indent).toBe(HASH);
    expect(input.search.get('company')).toBe('111111111');
    expect(q.getRegistrySourceCompanies).not.toHaveBeenCalled();
  });

  it('serves the register’s source records, noindexed, when they do not combine into a profile', async () => {
    const sources = [
      {
        eik: '111111111',
        name: 'ИВАН ПЕТРОВ',
        company: 'АЛФА ООД',
        href: null,
        fetchedAt: '2026-09-10T03:00:00Z',
      },
    ];
    server.loadPersonProfile.mockResolvedValue(null);
    q.getRegistrySourceCompanies.mockResolvedValue(sources);
    const res = await call({ id: HASH });
    expect(res.data).toEqual({ sources });
    expect(res.init.headers).toEqual({ 'X-Robots-Tag': 'noindex' });
    expect(q.getRegistrySourceCompanies).toHaveBeenCalledWith(DB, HASH);
  });

  it('404s when there is neither a profile nor a source record', async () => {
    server.loadPersonProfile.mockResolvedValue(null);
    q.getRegistrySourceCompanies.mockResolvedValue([]);
    await expect404(call({ id: HASH }));
  });
});
