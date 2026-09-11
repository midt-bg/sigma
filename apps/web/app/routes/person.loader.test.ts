import { afterEach, describe, expect, it, vi } from 'vitest';

// The person page's loader: a 404 — never an empty page under someone's name — for anything that is not the
// register's identifier and for a person the queries do not return, and the laid-out graph otherwise.
// @sigma/db is mocked: the query is the trust boundary this loader sits on.
const HASH = 'a'.repeat(64);
const q = vi.hoisted(() => ({
  getRegistryPerson: vi.fn(),
  registryPersonIdFromSlug: vi.fn((slug: string) => (/^[0-9a-f]{64}$/.test(slug) ? slug : null)),
  getDb: vi.fn((env: { DB: unknown }) => env.DB),
}));
vi.mock('@sigma/db', () => q);

import { loader } from './person';

const DB = {};
const call = (id: string) =>
  (loader as (a: unknown) => Promise<unknown>)({
    params: { id },
    context: { cloudflare: { env: { DB } } },
  });

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
  q.getRegistryPerson.mockReset();
});

describe('person loader', () => {
  it('404s anything that is not the register’s identifier, before reading', async () => {
    await expectStatus(call('ivan-petrov'), 404);
    expect(q.getRegistryPerson).not.toHaveBeenCalled();
  });

  it('404s a person the queries do not return', async () => {
    q.getRegistryPerson.mockResolvedValue(null);
    await expectStatus(call(HASH), 404);
    expect(q.getRegistryPerson).toHaveBeenCalledWith(DB, HASH);
  });

  it('returns the person with the graph laid out', async () => {
    const centre = {
      id: `rp:${HASH}`,
      kind: 'person',
      label: 'АННА ПЕТРОВА',
      slug: HASH,
      valueEur: 0,
      hop: 0,
      conflictsHref: null,
    };
    const company = {
      id: 'eik:111111111',
      kind: 'company',
      label: 'АЛФА ООД',
      slug: '111111111',
      valueEur: 1000,
      hop: 1,
      conflictsHref: null,
    };
    q.getRegistryPerson.mockResolvedValue({
      slug: HASH,
      name: 'АННА ПЕТРОВА',
      roles: [],
      companies: 1,
      wonEur: 1000,
      asOf: '2026-09-10',
      network: {
        center: centre,
        nodes: [centre, company],
        edges: [
          {
            from: centre.id,
            to: company.id,
            kind: 'role',
            directed: false,
            weightEur: 0,
            occurrences: 1,
            href: null,
            roles: ['manager'],
            current: true,
          },
        ],
        omitted: 0,
      },
    });
    const res = (await call(HASH)) as {
      person: { name: string };
      tieLayout: { nodes: { href: string }[] };
    };
    expect(res.person.name).toBe('АННА ПЕТРОВА');
    expect(res.tieLayout.nodes.map((n) => n.href)).toEqual([
      `/persons/${HASH}`,
      '/companies/111111111',
    ]);
  });
});
