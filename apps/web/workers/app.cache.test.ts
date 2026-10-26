import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLIGHT_MS, MAX_RENDERING } from './render-gate';

// Every request the stubbed React Router handler (the loaders) receives; while `held.gate` is set, every
// render waits on it, as for a slow D1.
const rendered = vi.hoisted(() => [] as Request[]);
const held = vi.hoisted(() => ({ gate: null as Promise<void> | null }));

// Exercises the REAL edge-cache middleware in app.ts (handleRequest -> cacheKey -> edgeCache
// match/put) without the SSR build or D1, to gate that app.ts actually keys the cache by cacheKey.
// The pure cacheKey test proves keys differ; this proves the middleware USES that key, so a
// /contracts?bids=1 response can never be served for /contracts (CWE-349, #56).

// Stub the React Router handler: the two URLs return DIFFERENT bodies — the whole reason `bids`
// must be in the cache key. The import thunk is never invoked, so no real build is loaded.
vi.mock('react-router', () => ({
  createRequestHandler: () => async (request: Request) => {
    rendered.push(request);
    if (held.gate) await held.gate;
    const url = new URL(request.url);
    // A designated path returns 404, to exercise the response.ok cache-put gate (see the „non-ok" test).
    if (url.pathname === '/contracts/missing') {
      return new Response('Not Found', {
        status: 404,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, s-maxage=1800',
        },
      });
    }
    const bids = url.searchParams.get('bids');
    const body = url.searchParams.has('_routes')
      ? `PARTIAL: ${url.searchParams.get('_routes')} only`
      : url.pathname === '/' || url.pathname === '/competition'
        ? `PAGE: ${url.pathname}${url.search}`
        : bids === '1'
          ? 'ROWS: single-bid only (2)'
          : 'ROWS: all contracts (5)';
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

beforeEach(() => {
  fakeCache.store.clear();
  rendered.length = 0;
  held.gate = null;
  vi.stubEnv('DEV', false);
});

async function get(url: string, method = 'GET') {
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void waits.push(p),
    passThroughOnException: () => {},
  };
  const res = await worker.fetch(new Request(url, { method }), {}, ctx);
  const body = await res.clone().text();
  await Promise.all(waits); // let edgeCache.put (ctx.waitUntil) settle before the next request
  return { edge: res.headers.get('X-Edge-Cache'), body, status: res.status, headers: res.headers };
}

describe('app.ts edge cache middleware', () => {
  it('bypasses persisted edge responses in local development across reloads', async () => {
    vi.stubEnv('DEV', true);
    expect((await get('https://x/contracts')).edge).toBe('BYPASS');
    expect((await get('https://x/contracts')).edge).toBe('BYPASS');
    expect(fakeCache.store.size).toBe(0);
  });
  it('caches per response — a repeated GET HITs', async () => {
    expect((await get('https://x/contracts')).edge).toBe('MISS');
    expect((await get('https://x/contracts')).edge).toBe('HIT');
  });

  it('a param the route does not read neither misses the cache nor reaches the loader', async () => {
    expect((await get('https://x/')).edge).toBe('MISS');
    const probe = await get('https://x/?q=unique-probe-1');
    expect(probe.edge).toBe('HIT');
    expect(probe.body).toBe('PAGE: /');
    expect(rendered).toHaveLength(1);
  });

  it('renders the page from the same canonical query the key carries', async () => {
    // The junk value is dropped before the loader, so the stored body is the one the key describes —
    // and the next plain visitor gets it from the cache.
    const junk = await get('https://x/competition?funding=bogus&sector=45&x=1');
    expect(junk.edge).toBe('MISS');
    expect(junk.body).toBe('PAGE: /competition?sector=45');
    expect(new URL(rendered[0]!.url).search).toBe('?sector=45');
    expect((await get('https://x/competition?sector=45')).edge).toBe('HIT');
    expect(rendered).toHaveLength(1);
  });

  it('answers HEAD from the GET entry, headers only, without running the loaders', async () => {
    expect((await get('https://x/network')).edge).toBe('MISS');
    const head = await get('https://x/network', 'HEAD'); // an upper-case path is redirected first (below)
    expect(head.edge).toBe('HIT');
    expect(head.body).toBe('');
    expect(rendered).toHaveLength(1);
  });

  it('fills the GET entry on a cold HEAD, so the next HEAD or GET is a HIT', async () => {
    const cold = await get('https://x/contracts', 'HEAD');
    expect(cold.edge).toBe('MISS');
    expect(cold.body).toBe('');
    expect(rendered[0]!.method).toBe('GET');
    expect((await get('https://x/contracts', 'HEAD')).edge).toBe('HIT');
    expect((await get('https://x/contracts')).body).toContain('all contracts');
    expect(rendered).toHaveLength(1);
  });

  it('renders identical concurrent misses once and serves the rest from its entry', async () => {
    let release!: () => void;
    held.gate = new Promise((resolve) => (release = resolve));
    const all = Promise.all(Array.from({ length: 5 }, () => get('https://x/competition')));
    await vi.waitFor(() => expect(rendered).toHaveLength(1));
    held.gate = null;
    release();

    const responses = await all;
    expect(rendered).toHaveLength(1);
    expect(responses.map((r) => r.edge).sort()).toEqual(['HIT', 'HIT', 'HIT', 'HIT', 'MISS']);
    expect(new Set(responses.map((r) => r.body))).toEqual(new Set(['PAGE: /competition']));
  });

  it('stops waiting for a first render whose cache entry never settles', async () => {
    // The first visitor left mid-put: its entry is never stored and the put never settles.
    const put = vi.spyOn(fakeCache, 'put').mockImplementationOnce(() => new Promise(() => {}));
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
    const first = await worker.fetch(new Request('https://x/competition'), {}, ctx);
    expect(first.headers.get('X-Edge-Cache')).toBe('MISS');

    vi.useFakeTimers();
    try {
      const next = get('https://x/competition');
      await vi.advanceTimersByTimeAsync(FLIGHT_MS);
      expect((await next).edge).toBe('MISS');
      expect(rendered).toHaveLength(2);
      // The page is in the cache again for everyone after it.
      expect((await get('https://x/competition')).edge).toBe('HIT');
    } finally {
      vi.useRealTimers();
      put.mockRestore();
    }
  });

  it('sheds a render past the in-flight cap with a 503 the client is told to retry', async () => {
    let release!: () => void;
    held.gate = new Promise((resolve) => (release = resolve));
    // Distinct pages, so none waits for another: each holds a render slot.
    const busy = Array.from({ length: MAX_RENDERING }, (_, i) =>
      get(`https://x/contracts?bidder=${i}`),
    );
    await vi.waitFor(() => expect(rendered).toHaveLength(MAX_RENDERING));

    const shed = await get('https://x/contracts?bidder=over');
    expect(shed.status).toBe(503);
    expect(shed.headers.get('Retry-After')).toBe('30');
    expect(shed.headers.get('Cache-Control')).toBe('no-store');
    expect(rendered).toHaveLength(MAX_RENDERING);

    held.gate = null;
    release();
    await Promise.all(busy);
    // The slots are free again.
    expect((await get('https://x/contracts?bidder=over')).edge).toBe('MISS');
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

  it('never stores nor serves a partial `_routes` answer under the page key', async () => {
    // One anonymous GET for a subset of the loaders must not become the data every visitor's navigation
    // to that page receives.
    const partial = await get('https://x/contracts.data?_routes=root');
    expect(partial.edge).toBe('BYPASS');
    expect(partial.body).toContain('PARTIAL: root only');
    expect(fakeCache.store.size).toBe(0);

    const whole = await get('https://x/contracts.data');
    expect(whole.edge).toBe('MISS');
    expect(whole.body).toContain('all contracts');

    // …and the cached whole answer is not handed to a partial request either.
    const again = await get('https://x/contracts.data?_routes=root');
    expect(again.edge).toBe('BYPASS');
    expect(again.body).toContain('PARTIAL: root only');
  });

  it('redirects an upper-case path even when its lower-case page is cached', async () => {
    expect((await get('https://x/contracts')).edge).toBe('MISS');
    const res = await worker.fetch(
      new Request('https://x/Contracts?bids=1'),
      {},
      {
        waitUntil: () => {},
        passThroughOnException: () => {},
      },
    );
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('/contracts?bids=1');
  });

  it('never caches a non-ok (404) response — the invariant cache-key.ts relies on (#221/#213)', async () => {
    // cache-key.ts collapses `%2F` → `/`, so an encoded contract URL (200) and a raw-slash form (404)
    // share one cache key. That is safe ONLY because a non-ok response is never stored — so the 404
    // form can't poison the encoded entry. This test pins that gate: a 404 stays BYPASS, never HIT.
    const first = await get('https://x/contracts/missing');
    expect(first.edge).toBe('BYPASS');
    const second = await get('https://x/contracts/missing');
    expect(second.edge).toBe('BYPASS');
  });
});
