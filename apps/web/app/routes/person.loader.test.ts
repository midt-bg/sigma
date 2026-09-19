import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The person page's loader: a 404 — never an empty page under someone's name — for anything that is not the
// register's identifier and for a person the queries do not return, and the laid-out graph otherwise.
// @sigma/db is mocked: the query is the trust boundary this loader sits on.
const HASH = 'a'.repeat(64);
const q = vi.hoisted(() => ({
  getRegistryPerson: vi.fn(),
  getRegistrySourceCompanies: vi.fn(),
  getPersonScope: vi.fn(),
  getPersonActivity: vi.fn(),
  getPersonTimeline: vi.fn(),
  getPersonDestinations: vi.fn(),
  getPersonSourceArchive: vi.fn(),
  getOfficialConflicts: vi.fn(),
  getPersonDeclarations: vi.fn(),
  getPersonSourceNames: vi.fn(async (): Promise<string[]> => []),
  getPersonRelatives: vi.fn(async () => []),
  getPersonNamedBy: vi.fn(async () => []),
  registryPersonIdFromSlug: vi.fn((slug: string) => (/^[0-9a-f]{64}$/.test(slug) ? slug : null)),
  // The declaration-derived slug; here only slugs of the form id-* decode, so a plain word is a 404.
  personIdFromSlug: vi.fn((slug: string) => (slug.startsWith('id-') ? `person:${slug}` : null)),
  personSlug: vi.fn((id: string) => id.replace(/^person:/, '')),
  getDb: vi.fn((env: { DB: unknown }) => env.DB),
}));
vi.mock('@sigma/db', () => q);

import { loader } from './person';
import { emptyActivity } from '../lib/person-profile.test-support';
beforeEach(() => {
  q.getPersonScope.mockImplementation(
    async (_db: unknown, { indent, officialId }: { indent?: string; officialId?: string }) => ({
      indent: indent ?? null,
      officialIds: officialId ? [officialId] : [],
    }),
  );
  q.getRegistrySourceCompanies.mockResolvedValue([]);
  q.getPersonActivity.mockResolvedValue(emptyActivity);
  q.getPersonTimeline.mockResolvedValue({ contracts: [], observations: [], reads: [] });
  q.getPersonDestinations.mockResolvedValue([]);
  q.getPersonSourceArchive.mockResolvedValue(null);
  q.getOfficialConflicts.mockResolvedValue(null);
  q.getPersonDeclarations.mockResolvedValue([]);
});

const DB = {};
const call = (id: string, search = '') =>
  (loader as (a: unknown) => Promise<unknown>)({
    params: { id },
    request: new Request(`http://localhost:5173/persons/${id}${search}`),
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
  vi.clearAllMocks();
  q.getRegistryPerson.mockReset();
});

describe('person loader', () => {
  it('404s anything that is neither identifier, before reading', async () => {
    await expectStatus(call('ivan-petrov'), 404);
    expect(q.getRegistryPerson).not.toHaveBeenCalled();
    expect(q.getPersonDestinations).not.toHaveBeenCalled();
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
    const res = ((await call(HASH)) as { data: unknown }).data as {
      person: { name: string };
      tieLayout: { nodes: { href: string }[] };
    };
    expect(res.person.name).toBe('АННА ПЕТРОВА');
    expect(res.tieLayout.nodes.map((n) => n.href)).toEqual([
      `/persons/${HASH}`,
      '/companies/111111111',
    ]);
  });

  it('404s a declaration-derived id with neither profile nor archived documents', async () => {
    await expectStatus(call('id-1'), 404);
    expect(q.getOfficialConflicts).toHaveBeenCalledWith(DB, 'person:id-1', { contracts: false });
    expect(q.getPersonSourceArchive).toHaveBeenCalledWith(DB, 'person:id-1');
  });

  it('returns the profile for a declaration-derived id', async () => {
    q.getOfficialConflicts.mockResolvedValue({ official: 'Иван Петров', links: [], contracts: {} });
    const res = ((await call('id-1')) as { data: { name: string } }).data;
    expect(res.name).toBe('Иван Петров');
  });

  it('reads the register identity a declaration-derived id resolved to', async () => {
    q.getPersonScope.mockResolvedValue({ indent: HASH, officialIds: ['person:id-1'] });
    q.getRegistryPerson.mockResolvedValue({
      name: 'Иван Петров',
      network: { center: null, nodes: [], edges: [] },
    });
    q.getOfficialConflicts.mockResolvedValue({ official: 'Иван Петров', links: [], contracts: {} });
    const res = ((await call('id-1')) as { data: { person: unknown } }).data;
    expect(res.person).not.toBeNull();
    expect(q.getPersonActivity).toHaveBeenCalledWith(
      DB,
      HASH,
      ['person:id-1'],
      expect.any(URLSearchParams),
      'all',
    );
  });

  it('sends an id that moved into one profile there, keeping the query and the fragment', async () => {
    q.getPersonDestinations.mockResolvedValue([{ id: 'person:id-2', kind: 'person' }]);
    await expectStatus(call('id-1', '?company=1#contracts'), 302);
    expect(q.getOfficialConflicts).not.toHaveBeenCalled();
  });

  it('lists the profiles an id was split into, unless the profile itself is asked for', async () => {
    const destinations = [
      { id: 'person:id-2', kind: 'person', name: 'А', declaration_count: 1, institutions: null },
      { id: 'person:id-3', kind: 'source', name: 'Б', declaration_count: 2, institutions: null },
    ];
    q.getPersonDestinations.mockResolvedValue(destinations);
    const res = ((await call('id-1')) as { data: { destinations: unknown } }).data;
    expect(res.destinations).toEqual(destinations);
    expect(q.getOfficialConflicts).not.toHaveBeenCalled();
    q.getOfficialConflicts.mockResolvedValue({ official: 'А', links: [], contracts: {} });
    const profile = ((await call('id-1', '?view=profile')) as { data: { name: string } }).data;
    expect(profile.name).toBe('А');
  });

  it('shows the archived documents when a declaration-derived id has no profile', async () => {
    q.getPersonSourceArchive.mockResolvedValue({ name: 'Иван Петров', declarations: [] });
    const res = ((await call('id-1')) as { data: { source: { name: string } } }).data;
    expect(res.source.name).toBe('Иван Петров');
  });
});
