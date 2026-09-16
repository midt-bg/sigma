import { afterEach, describe, expect, it, vi } from 'vitest';

// The /conflicts/official/:id loader resolves an id from an earlier identity grain against the current
// profiles: several destinations are listed (unless the reader asked for the profile itself), a single other
// one is a redirect that keeps the query and fragment, and a person with no profile but attributed documents
// gets the source archive. The id ↔ slug codec is the real one; the reads are mocked, and the profile read
// has its own tests.
const q = vi.hoisted(() => ({
  getDb: vi.fn((env: { DB: unknown }) => env.DB),
  getPersonDestinations: vi.fn(),
  getPersonSourceArchive: vi.fn(),
}));
const server = vi.hoisted(() => ({ loadPersonProfile: vi.fn() }));
vi.mock('@sigma/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sigma/db')>()),
  ...q,
}));
vi.mock('../lib/person-profile.server', () => server);

import { personSlug } from '@sigma/db';
import { loader } from './conflict.official';

const DB = {};
const ID = 'person:source-7';
const destination = (id: string) => ({
  id,
  name: 'ИВАН ПЕТРОВ',
  kind: 'person' as const,
  declaration_count: 2,
  institutions: 'Община Русе',
});
const call = (query = '') =>
  (loader as (a: unknown) => Promise<unknown>)({
    params: { id: personSlug(ID) },
    request: new Request(`http://localhost:5173/conflicts/official/${personSlug(ID)}${query}`),
    context: { cloudflare: { env: { DB } } },
  });
const thrownBy = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected the loader to throw a Response');
    },
    (e: unknown) => e as Response,
  );

afterEach(() => vi.clearAllMocks());

describe('official loader — earlier identities', () => {
  it('lists the profiles an id was carried into, without choosing one', async () => {
    const destinations = [destination('person:a'), destination('person:b')];
    q.getPersonDestinations.mockResolvedValue(destinations);
    expect(await call()).toEqual({ destinations });
    expect(q.getPersonDestinations).toHaveBeenCalledWith(DB, ID);
    expect(server.loadPersonProfile).not.toHaveBeenCalled();
  });

  it('serves the profile itself when the list’s ?view=profile link is followed', async () => {
    const profile = { name: 'ИВАН ПЕТРОВ' };
    q.getPersonDestinations.mockResolvedValue([destination(ID), destination('person:b')]);
    server.loadPersonProfile.mockResolvedValue(profile);
    expect(await call('?view=profile')).toBe(profile);
    const [db, input] = server.loadPersonProfile.mock.calls[0]!;
    expect(db).toBe(DB);
    expect(input.officialId).toBe(ID);
    expect(input.search.get('view')).toBe('profile');
  });

  it('redirects to the one current profile, keeping the query and the fragment', async () => {
    q.getPersonDestinations.mockResolvedValue([destination('person:current-3')]);
    const res = await thrownBy(call('?company=111111111&basis=matched#contracts'));
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(
      `/conflicts/official/${personSlug('person:current-3')}?company=111111111&basis=matched#contracts`,
    );
    expect(server.loadPersonProfile).not.toHaveBeenCalled();
  });

  it('serves the profile in place when the one destination is the requested id', async () => {
    const profile = { name: 'ИВАН ПЕТРОВ' };
    q.getPersonDestinations.mockResolvedValue([destination(ID)]);
    server.loadPersonProfile.mockResolvedValue(profile);
    expect(await call()).toBe(profile);
  });
});

describe('official loader — no combined profile', () => {
  it('serves the attributed source archive', async () => {
    const source = { name: 'ИВАН ПЕТРОВ', declarations: [{ id: 'd1' }] };
    q.getPersonDestinations.mockResolvedValue([]);
    server.loadPersonProfile.mockResolvedValue(null);
    q.getPersonSourceArchive.mockResolvedValue(source);
    expect(await call()).toEqual({ source });
    expect(q.getPersonSourceArchive).toHaveBeenCalledWith(DB, ID);
  });

  it('404s when there is no source archive either', async () => {
    q.getPersonDestinations.mockResolvedValue([]);
    server.loadPersonProfile.mockResolvedValue(null);
    q.getPersonSourceArchive.mockResolvedValue(null);
    expect((await thrownBy(call())).status).toBe(404);
  });
});
