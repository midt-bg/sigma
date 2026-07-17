import { afterEach, describe, expect, it, vi } from 'vitest';

// Loader-level tests for the свързани-лица routes. The rendered surface is covered by Playwright E2E;
// these prove the loader GLUE in isolation (node env, no DOM) — the 404 guards that keep a bare page from
// ever appearing under someone's name, and the self-vs-family link_key construction (a libel-critical
// distinction: a self-link and a relative-link for the same slug+eik must never collapse to one key).
//
// @sigma/db is mocked so the loaders run without a real D1: the query functions are the trust boundary the
// loaders sit on top of, and here we drive their return values to exercise every branch.
const q = vi.hoisted(() => ({
  getConflictLeaderboard: vi.fn(),
  getOfficialConflicts: vi.fn(),
  getCompanyConflicts: vi.fn(),
  getLinkContracts: vi.fn(),
  personIdFromSlug: vi.fn(),
}));
vi.mock('@sigma/db', () => q);

import { loader as leaderboardLoader } from './conflicts';
import { loader as officialLoader } from './conflict.official';
import { loader as companyLoader } from './conflict.company';
import { loader as contractsLoader } from './conflict.contracts';

const DB = {}; // the loaders only forward it to the (mocked) query fns; identity is all we assert on
const context = { cloudflare: { env: { DB } } };
const call = (loader: unknown, params: Record<string, string | undefined>) =>
  (loader as (a: { params: typeof params; context: typeof context }) => Promise<unknown>)({
    params,
    context,
  });

// A loader that throws a Response is the 404 contract. Assert both that it throws and the status.
async function expectStatus(promise: Promise<unknown>, status: number) {
  try {
    await promise;
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(status);
    return;
  }
  throw new Error(`expected a ${status} Response to be thrown, but the loader resolved`);
}

afterEach(() => {
  for (const fn of Object.values(q)) fn.mockReset();
});

describe('leaderboard loader (/conflicts)', () => {
  it('caches for an hour when there are links', async () => {
    q.getConflictLeaderboard.mockResolvedValue([{ linkKey: 'p|1' }]);
    const res = (await leaderboardLoader({ context } as never)) as {
      data: unknown[];
      init: { headers: Record<string, string> };
    };
    expect(res.data).toHaveLength(1);
    expect(res.init.headers['Cache-Control']).toMatch(/s-maxage=3600/);
  });

  it('does NOT cache an empty read (avoids pinning a just-shipped empty surface for an hour)', async () => {
    q.getConflictLeaderboard.mockResolvedValue([]);
    const res = (await leaderboardLoader({ context } as never)) as {
      init: { headers: Record<string, string> };
    };
    expect(res.init.headers['Cache-Control']).toBe('no-store');
  });
});

describe('official loader (/conflicts/official/:id)', () => {
  it('404s an unresolvable slug before any DB read (no bare page under a name)', async () => {
    q.personIdFromSlug.mockReturnValue(null);
    await expectStatus(call(officialLoader, { id: 'not-a-real-slug' }), 404);
    expect(q.getOfficialConflicts).not.toHaveBeenCalled();
  });

  it('404s when the person has no published links (null result)', async () => {
    q.personIdFromSlug.mockReturnValue('person:1');
    q.getOfficialConflicts.mockResolvedValue(null);
    await expectStatus(call(officialLoader, { id: 'ivan-petrov-1' }), 404);
  });

  it('returns the conflict payload for a valid official', async () => {
    q.personIdFromSlug.mockReturnValue('person:1');
    q.getOfficialConflicts.mockResolvedValue({ official: 'Иван Петров', links: [] });
    const res = (await call(officialLoader, { id: 'ivan-petrov-1' })) as { official: string };
    expect(res.official).toBe('Иван Петров');
    expect(q.getOfficialConflicts).toHaveBeenCalledWith(DB, 'person:1');
  });
});

describe('company loader (/conflicts/company/:eik)', () => {
  it('404s a blank eik before any DB read', async () => {
    await expectStatus(call(companyLoader, { eik: '   ' }), 404);
    expect(q.getCompanyConflicts).not.toHaveBeenCalled();
  });

  it('404s when the company has no published links (null result)', async () => {
    q.getCompanyConflicts.mockResolvedValue(null);
    await expectStatus(call(companyLoader, { eik: '123456789' }), 404);
  });

  // A БГ ЕИК is 9 or 13 digits — always numeric. A non-numeric :eik can only be a probe/garbage; 404 it
  // before any DB read, and before it reaches meta/URL. Guards uniformly with the sibling loaders.
  it.each([
    { eik: 'abc', why: 'non-numeric' },
    { eik: '123|family', why: 'a decoded key-delimiter (%7C)' },
    { eik: '12 34', why: 'embedded whitespace' },
  ])('404s a $why eik before any DB read', async ({ eik }) => {
    await expectStatus(call(companyLoader, { eik }), 404);
    expect(q.getCompanyConflicts).not.toHaveBeenCalled();
  });

  it('returns the conflict payload for a valid company', async () => {
    q.getCompanyConflicts.mockResolvedValue({ company: 'АЛФА ООД', eik: '123456789', links: [] });
    const res = (await call(companyLoader, { eik: '123456789' })) as { company: string };
    expect(res.company).toBe('АЛФА ООД');
  });
});

describe('contracts resource loader (/conflicts/link/:scope/:slug/:eik/contracts)', () => {
  it.each([
    { params: { scope: 'self', slug: '', eik: '1' }, why: 'blank slug' },
    { params: { scope: 'self', slug: 'ivan', eik: '' }, why: 'blank eik' },
    { params: { scope: 'sideways', slug: 'ivan', eik: '1' }, why: 'unknown scope' },
    // %7C decodes to '|' before the loader sees it. Without an eik format guard, scope=self + eik='123|family'
    // builds `person:1|123|family` — byte-identical to the FAMILY key for eik=123, collapsing the self- and
    // family-link contract lists into one (a libel-critical leak: the relative's contracts shown as the
    // official's own). A numeric-only :eik makes the collision unrepresentable.
    { params: { scope: 'self', slug: 'ivan', eik: '123|family' }, why: 'a key-delimiter in eik' },
    { params: { scope: 'self', slug: 'ivan', eik: 'abc' }, why: 'a non-numeric eik' },
  ])('404s on $why', async ({ params }) => {
    q.personIdFromSlug.mockReturnValue(params.slug ? 'person:1' : null);
    await expectStatus(call(contractsLoader, params), 404);
    expect(q.getLinkContracts).not.toHaveBeenCalled();
  });

  it('builds a SELF link_key (personId|eik) — never collapses with the family key', async () => {
    q.personIdFromSlug.mockReturnValue('person:1');
    q.getLinkContracts.mockResolvedValue([{ contractNumber: 'A-1' }]);
    await call(contractsLoader, { scope: 'self', slug: 'ivan-petrov-1', eik: '123456789' });
    expect(q.getLinkContracts).toHaveBeenCalledWith(DB, 'person:1|123456789');
  });

  it('builds a FAMILY link_key (personId|eik|family) — distinct from the self key', async () => {
    q.personIdFromSlug.mockReturnValue('person:1');
    q.getLinkContracts.mockResolvedValue([{ contractNumber: 'A-1' }]);
    await call(contractsLoader, { scope: 'family', slug: 'ivan-petrov-1', eik: '123456789' });
    expect(q.getLinkContracts).toHaveBeenCalledWith(DB, 'person:1|123456789|family');
  });

  it('does not pin an empty contracts read (no-store), but caches a non-empty one', async () => {
    q.personIdFromSlug.mockReturnValue('person:1');
    q.getLinkContracts.mockResolvedValue([]);
    const empty = (await call(contractsLoader, { scope: 'self', slug: 'ivan', eik: '1' })) as {
      init: { headers: Record<string, string> };
    };
    expect(empty.init.headers['Cache-Control']).toBe('no-store');

    q.getLinkContracts.mockResolvedValue([{ contractNumber: 'A-1' }]);
    const full = (await call(contractsLoader, { scope: 'self', slug: 'ivan', eik: '1' })) as {
      init: { headers: Record<string, string> };
    };
    expect(full.init.headers['Cache-Control']).toMatch(/s-maxage=3600/);
  });
});
