import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercises the REAL edge-cache middleware in app.ts (handleRequest -> cacheKey -> edgeCache
// match/put) without the SSR build or D1, to gate that app.ts actually keys the cache by cacheKey.
// The pure cacheKey test proves keys differ; this proves the middleware USES that key, so a
// /contracts?bids=1 response can never be served for /contracts (CWE-349, #56).

// Stub the React Router handler: the two URLs return DIFFERENT bodies — the whole reason `bids`
// must be in the cache key. The import thunk is never invoked, so no real build is loaded.
vi.mock('react-router', () => ({
  createRequestHandler: () => async (request: Request) => {
    const bids = new URL(request.url).searchParams.get('bids');
    const body = bids === '1' ? 'ROWS: single-bid only (2)' : 'ROWS: all contracts (5)';
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, s-maxage=1800',
      },
    });
  },
}));
vi.mock('virtual:react-router/server-build', () => ({}));
// Pass through the log wrapper; disable rate limiters (they need real DO bindings otherwise).
vi.mock('./request-log', () => ({
  withRequestLog: (
    request: Request,
    env: unknown,
    ctx: unknown,
    handler: (r: Request, e: unknown, c: unknown) => Promise<Response>,
  ) => handler(request, env, ctx),
}));
vi.mock('./aggregation-rate-limit', () => ({ rateLimitAggregationRoute: async () => null }));
vi.mock('./csv-rate-limit', () => ({ rateLimitCsvExport: async () => null }));
vi.mock('./search-rate-limit', () => ({ rateLimitSearchRoute: async () => null }));

// Minimal stand-in for caches.default (Cloudflare Cache API), keyed by the cache-key URL.
function makeFakeCache() {
  const store = new Map<
    string,
    { body: string; status: number; statusText: string; headers: [string, string][] }
  >();
  return {
    store,
    async match(req: Request | string) {
      const url = typeof req === 'string' ? req : req.url;
      const e = store.get(url);
      return e
        ? new Response(e.body, {
            status: e.status,
            statusText: e.statusText,
            headers: new Headers(e.headers),
          })
        : undefined;
    },
    async put(req: Request | string, res: Response) {
      const url = typeof req === 'string' ? req : req.url;
      store.set(url, {
        body: await res.text(),
        status: res.status,
        statusText: res.statusText,
        headers: [...res.headers] as [string, string][],
      });
    },
  };
}

const fakeCache = makeFakeCache();
let worker: { fetch: (r: Request, env: unknown, ctx: unknown) => Promise<Response> };

beforeAll(async () => {
  // edgeCache = caches.default is captured at module load, so stub before importing app.ts.
  vi.stubGlobal('caches', { default: fakeCache });
  worker = ((await import('./app')) as { default: typeof worker }).default;
});

beforeEach(() => fakeCache.store.clear());

async function get(url: string) {
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void waits.push(p),
    passThroughOnException: () => {},
  };
  const res = await worker.fetch(new Request(url), {}, ctx);
  const body = await res.clone().text();
  await Promise.all(waits); // let edgeCache.put (ctx.waitUntil) settle before the next request
  return { edge: res.headers.get('X-Edge-Cache'), body };
}

describe('app.ts edge cache middleware', () => {
  it('caches per response — a repeated GET HITs', async () => {
    expect((await get('https://x/contracts')).edge).toBe('MISS');
    expect((await get('https://x/contracts')).edge).toBe('HIT');
  });

  it('never serves the ?bids=1 body for /contracts (CWE-349, #56)', async () => {
    const primed = await get('https://x/contracts?bids=1'); // primes the bids=1 entry first
    expect(primed.edge).toBe('MISS');
    expect(primed.body).toContain('single-bid only');

    const broad = await get('https://x/contracts'); // distinct key -> MISS, its own body
    expect(broad.edge).toBe('MISS');
    expect(broad.body).toContain('all contracts');
    expect(broad.body).not.toContain('single-bid only'); // the poisoning the fix prevents
  });
});
