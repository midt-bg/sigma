// Loader tests for the /conflicts/link/:scope/:slug/:eik/contracts resource route. The libel-critical part is
// the server-side reconstruction of the link_key from the URL-safe segments: a self-link and a family-link
// for the same (slug, eik) must map to DISTINCT keys and never collapse, and any input that could smuggle a
// '|' into the eik (building the family key under a self scope) must 404 before any DB read.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const getLinkContracts = vi.fn(async () => [] as unknown[]);
vi.mock('@sigma/db', () => ({
  getDb: () => ({}),
  // Only a base64url-looking slug resolves; anything else is an unresolvable person → 404.
  personIdFromSlug: (s: string) =>
    /^[A-Za-z0-9_-]+$/.test(s) && s.length > 0 ? `person:${s}` : null,
  getLinkContracts,
}));

const { loader } = await import('./conflict.contracts');

const ctx = { cloudflare: { env: {} } } as never;
const call = (scope: string, slug: string, eik: string) =>
  loader({ params: { scope, slug, eik }, context: ctx } as never);

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (e) {
    if (e instanceof Response) return e.status;
    throw e;
  }
}

beforeEach(() => {
  getLinkContracts.mockReset();
  getLinkContracts.mockResolvedValue([]);
});

describe('conflict.contracts loader', () => {
  it('404s an unresolvable slug before any DB read', async () => {
    expect(await status(call('self', '', '111'))).toBe(404);
    expect(getLinkContracts).not.toHaveBeenCalled();
  });

  it('404s a non-numeric eik — blocks smuggling a „|family" into the eik under scope=self', async () => {
    expect(await status(call('self', 'ivan', '111|family'))).toBe(404);
    expect(await status(call('self', 'ivan', 'abc'))).toBe(404);
    expect(getLinkContracts).not.toHaveBeenCalled();
  });

  it('404s an unknown scope (only self | family)', async () => {
    expect(await status(call('managed', 'ivan', '111'))).toBe(404);
    expect(getLinkContracts).not.toHaveBeenCalled();
  });

  it('builds the SELF key `pid|eik` for scope=self', async () => {
    getLinkContracts.mockResolvedValue([{ contractSlug: 'c1' }]);
    const res = (await call('self', 'ivan', '111')) as { data: { linkKey: string } };
    expect(getLinkContracts).toHaveBeenCalledWith(expect.anything(), 'person:ivan|111');
    expect(res.data.linkKey).toBe('person:ivan|111');
  });

  it('builds the DISTINCT FAMILY key `pid|eik|family` for scope=family — never collapses with self', async () => {
    getLinkContracts.mockResolvedValue([{ contractSlug: 'c1' }]);
    const res = (await call('family', 'ivan', '111')) as { data: { linkKey: string } };
    expect(getLinkContracts).toHaveBeenCalledWith(expect.anything(), 'person:ivan|111|family');
    expect(res.data.linkKey).toBe('person:ivan|111|family');
  });

  it('caches for an hour only when contracts exist; no-store on an empty read', async () => {
    getLinkContracts.mockResolvedValue([{ contractSlug: 'c1' }]);
    const withData = (await call('self', 'ivan', '111')) as {
      init: { headers: Record<string, string> };
    };
    expect(withData.init.headers['Cache-Control']).toContain('s-maxage=3600');

    getLinkContracts.mockResolvedValue([]);
    const empty = (await call('self', 'ivan', '111')) as {
      init: { headers: Record<string, string> };
    };
    expect(empty.init.headers['Cache-Control']).toBe('no-store');
  });
});
