import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEEP_SECONDS, SAME_DATA_SECONDS } from './edge-entry';
import { FLIGHT_MS } from './render-gate';

// Every request the stubbed React Router handler (the loaders) receives; while `held.gate` is set, every
// render waits on it, as for a slow D1.
const rendered = vi.hoisted(() => [] as Request[]);
// The env each render was handed, in the same order.
const envs = vi.hoisted(() => [] as { DB?: unknown }[]);
const held = vi.hoisted(() => ({ gate: null as Promise<void> | null }));
const reply = vi.hoisted(() => ({ status: 200, throws: false }));
// The data generation the worker believes current, and the answer of the page-view limiter (null: allowed).
const data = vi.hoisted(() => ({ generation: null as string | null }));
const limiter = vi.hoisted(() => ({ refusal: null as Response | null }));

// Exercises the REAL edge-cache middleware in app.ts (handleRequest -> cacheKey -> edgeCache
// match/put) without the SSR build or D1, to gate that app.ts actually keys the cache by cacheKey.
// The pure cacheKey test proves keys differ; this proves the middleware USES that key, so a
// /contracts?bids=1 response can never be served for /contracts (CWE-349, #56).

// Stub the React Router handler: the two URLs return DIFFERENT bodies — the whole reason `bids`
// must be in the cache key. The import thunk is never invoked, so no real build is loaded.
vi.mock('react-router', () => ({
  createRequestHandler:
    () => async (request: Request, context: { cloudflare: { env: { DB?: unknown } } }) => {
      rendered.push(request);
      envs.push(context.cloudflare.env);
      if (held.gate) await held.gate;
      if (reply.throws) throw new Error('render failed');
      const url = new URL(request.url);
      if (reply.status !== 200) {
        return new Response('Temporary failure', {
          status: reply.status,
          headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, s-maxage=1800' },
        });
      }
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
          'Content-Type': url.pathname.endsWith('.data')
            ? 'text/x-script'
            : 'text/html; charset=utf-8',
          'Cache-Control': 'public, s-maxage=1800',
          ETag: '"test-v1"',
          'Last-Modified': 'Mon, 02 Nov 2026 00:00:00 GMT',
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
vi.mock('./aggregation-rate-limit', () => ({
  rateLimitAggregationRoute: async () => limiter.refusal,
}));
vi.mock('./data-generation', () => ({ dataGeneration: () => data.generation }));
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
      if (e && typeof req !== 'string') {
        const headers = new Headers(e.headers);
        const etag = req.headers.get('If-None-Match');
        const modifiedSince = req.headers.get('If-Modified-Since');
        if (
          (etag && etag === headers.get('ETag')) ||
          (!etag && modifiedSince && modifiedSince === headers.get('Last-Modified'))
        ) {
          // Cloudflare's conditional Cache API HIT omits the original representation's type.
          headers.delete('Content-Type');
          return new Response(null, { status: 304, headers });
        }
      }
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
  envs.length = 0;
  held.gate = null;
  reply.status = 200;
  reply.throws = false;
  data.generation = null;
  limiter.refusal = null;
  vi.stubEnv('DEV', false);
});

async function get(
  url: string,
  method = 'GET',
  headers?: Record<string, string>,
  env: unknown = {},
) {
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void waits.push(p),
    passThroughOnException: () => {},
  };
  const res = await worker.fetch(new Request(url, { method, headers }), env, ctx);
  const body = await res.clone().text();
  await Promise.all(waits); // let edgeCache.put (ctx.waitUntil) settle before the next request
  return { edge: res.headers.get('X-Edge-Cache'), body, status: res.status, headers: res.headers };
}

describe('app.ts edge cache middleware', () => {
  it('does not extend browser freshness if the conditional entry expires during lookup', async () => {
    await get('https://x/contracts');
    const match = fakeCache.match.bind(fakeCache);
    // The first lookup reads the stored copy itself; the entry goes between the conditional one and the
    // lookup of the representation's type.
    const spy = vi
      .spyOn(fakeCache, 'match')
      .mockImplementationOnce(match)
      .mockImplementationOnce(async (key) => {
        const response = await match(key);
        fakeCache.store.clear();
        return response;
      });
    try {
      const conditional = await get('https://x/contracts', 'GET', { 'If-None-Match': '"test-v1"' });
      expect(conditional.status).toBe(304);
      expect(conditional.body).toBe('');
      expect(conditional.headers.get('Cache-Control')).toBe('no-store');
      expect(rendered).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ['GET', 'If-None-Match', '"test-v1"'],
    ['HEAD', 'If-None-Match', '"test-v1"'],
    ['GET', 'If-Modified-Since', 'Mon, 02 Nov 2026 00:00:00 GMT'],
    ['HEAD', 'If-Modified-Since', 'Mon, 02 Nov 2026 00:00:00 GMT'],
  ])('keeps browser revalidation on a conditional %s using %s', async (method, name, value) => {
    await get('https://x/contracts');
    const conditional = await get('https://x/contracts', method, { [name]: value });
    expect(conditional.status).toBe(304);
    expect(conditional.edge).toBe('HIT');
    expect(conditional.body).toBe('');
    expect(conditional.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(rendered).toHaveLength(1);
    // The stored copy is kept past the route's freshness, and remembers what the route asked for.
    const stored = [...fakeCache.store.values()][0].headers;
    expect(stored).toContainEqual([
      'cache-control',
      `public, s-maxage=${SAME_DATA_SECONDS + KEEP_SECONDS}`,
    ]);
    expect(stored).toContainEqual(['x-sigma-cache-control', 'public, s-maxage=1800']);
  });

  it.each(['https://x/contracts', 'https://x/contracts.data'])(
    'revalidates browser responses on MISS, HIT and HEAD while retaining edge TTL: %s',
    async (url) => {
      expect((await get(url)).headers.get('Cache-Control')).toBe(
        'public, max-age=0, must-revalidate',
      );
      const hit = await get(url);
      expect(hit.edge).toBe('HIT');
      expect(hit.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
      const head = await get(url, 'HEAD');
      expect(head.edge).toBe('HIT');
      expect(head.body).toBe('');
      expect(head.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
      const stored = [...fakeCache.store.values()][0].headers;
      expect(stored).toContainEqual([
        'cache-control',
        `public, s-maxage=${SAME_DATA_SECONDS + KEEP_SECONDS}`,
      ]);
      expect(stored).toContainEqual(['x-sigma-cache-control', 'public, s-maxage=1800']);
      expect(rendered).toHaveLength(1);
    },
  );

  it.each([500, 502, 503, 504])(
    'does not cache a %i and recovers on the next request',
    async (status) => {
      reply.status = status;
      const failed = await get('https://x/contracts.data');
      expect(failed.status).toBe(status);
      expect(failed.headers.get('Cache-Control')).toBe('no-store');
      expect(failed.headers.get('Retry-After')).toBe(status === 503 ? '30' : null);
      expect(fakeCache.store.size).toBe(0);
      reply.status = 200;
      const recovered = await get('https://x/contracts.data');
      expect(recovered.status).toBe(200);
      expect(recovered.edge).toBe('MISS');
      expect(recovered.body).not.toContain('Temporary failure');
    },
  );

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

  it('renders every concurrent miss of distinct pages: no cap refuses a visitor', async () => {
    let release!: () => void;
    held.gate = new Promise((resolve) => (release = resolve));
    // Distinct pages, so none waits for another; far more than any isolate used to admit at once.
    const busy = Array.from({ length: 60 }, (_, i) => get(`https://x/contracts?bidder=${i}`));
    await vi.waitFor(() => expect(rendered).toHaveLength(60));
    held.gate = null;
    release();
    expect((await Promise.all(busy)).map((r) => r.status)).toEqual(Array(60).fill(200));
  });

  // The mocked route asks for 1800 s; `later` moves the clock that far past a first render and back.
  async function later<T>(seconds: number, run: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + seconds * 1000);
      return await run();
    } finally {
      vi.useRealTimers();
    }
  }
  const notes = (headers: Headers) =>
    [...headers.keys()].filter((name) => name.startsWith('x-sigma-'));

  it.each([500, 503])(
    'serves the last good copy when an expired page answers %i, and renders again once it can',
    async (status) => {
      const first = await get('https://x/contracts');
      reply.status = status;
      const stale = await later(1801, () => get('https://x/contracts'));
      expect(stale.status).toBe(200);
      expect(stale.edge).toBe('STALE');
      expect(stale.body).toBe(first.body);
      expect(stale.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
      expect(rendered).toHaveLength(2);

      reply.status = 200;
      expect((await later(1801, () => get('https://x/contracts'))).edge).toBe('MISS');
      expect(rendered).toHaveLength(3);
    },
  );

  it('serves the last good copy when the render throws', async () => {
    await get('https://x/contracts');
    reply.throws = true;
    const stale = await later(1801, () => get('https://x/contracts'));
    expect(stale.status).toBe(200);
    expect(stale.edge).toBe('STALE');
  });

  it('lets the failure through when the render throws and there is no copy to give', async () => {
    reply.throws = true;
    await expect(get('https://x/contracts')).rejects.toThrow('render failed');
    // The failed render holds nothing back: the page renders for the next visitor.
    reply.throws = false;
    expect((await get('https://x/contracts')).edge).toBe('MISS');
  });

  it('gives every visitor who waited on a failed render the last good copy', async () => {
    const first = await get('https://x/contracts');
    reply.status = 503;
    const answers = await later(1801, async () => {
      let release!: () => void;
      held.gate = new Promise((resolve) => (release = resolve));
      const both = Promise.all([get('https://x/contracts'), get('https://x/contracts')]);
      await vi.waitFor(() => expect(rendered).toHaveLength(2));
      held.gate = null;
      release();
      return both;
    });
    expect(answers.map((r) => r.edge)).toEqual(['STALE', 'STALE']);
    expect(answers.map((r) => r.body)).toEqual([first.body, first.body]);
  });

  it('renders for a visitor who waited on a render that left nothing stored', async () => {
    let release!: () => void;
    held.gate = new Promise((resolve) => (release = resolve));
    const both = Promise.all([
      get('https://x/contracts/missing'),
      get('https://x/contracts/missing'),
    ]);
    await vi.waitFor(() => expect(rendered).toHaveLength(1));
    held.gate = null;
    release();
    expect((await both).map((r) => r.status)).toEqual([404, 404]);
    expect(rendered).toHaveLength(2);
  });

  it('answers a validator that no longer matches with the page itself', async () => {
    const first = await get('https://x/contracts');
    const changed = await get('https://x/contracts', 'GET', { 'If-None-Match': '"test-v0"' });
    expect(changed.status).toBe(200);
    expect(changed.edge).toBe('HIT');
    expect(changed.body).toBe(first.body);
    expect(rendered).toHaveLength(1);
  });

  it('serves the copy it already holds when the entry goes before the conditional lookup', async () => {
    const first = await get('https://x/contracts');
    const match = fakeCache.match.bind(fakeCache);
    const spy = vi
      .spyOn(fakeCache, 'match')
      .mockImplementationOnce(match)
      .mockImplementationOnce(async () => undefined);
    try {
      const answer = await get('https://x/contracts', 'GET', { 'If-None-Match': '"test-v1"' });
      expect(answer.status).toBe(200);
      expect(answer.edge).toBe('HIT');
      expect(answer.body).toBe(first.body);
      expect(rendered).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('answers a missing page as missing, never with an old copy of it', async () => {
    await get('https://x/contracts/missing?x=1');
    await get('https://x/contracts');
    // The record behind a stored page is gone: its 404 is the current answer.
    const key = [...fakeCache.store.keys()][0]!;
    fakeCache.store.set(key.replace('/contracts', '/contracts/missing'), fakeCache.store.get(key)!);
    const gone = await later(1801, () => get('https://x/contracts/missing'));
    expect(gone.status).toBe(404);
    expect(gone.edge).toBe('BYPASS');
  });

  it('gives a rate-limited visitor the last good copy, and the refusal only when there is none', async () => {
    await get('https://x/contracts');
    limiter.refusal = new Response('Too many', { status: 429 });
    const stale = await later(1801, () => get('https://x/contracts'));
    expect(stale.status).toBe(200);
    expect(stale.edge).toBe('STALE');
    expect(rendered).toHaveLength(1);

    limiter.refusal = new Response('Too many', { status: 429 });
    expect((await get('https://x/contracts?bids=1')).status).toBe(429);
  });

  it('keeps a page of the current data generation past the freshness its route asked for', async () => {
    data.generation = 'refresh-1|publish-1';
    await get('https://x/contracts');
    expect((await later(1801, () => get('https://x/contracts'))).edge).toBe('HIT');
    expect((await later(SAME_DATA_SECONDS - 1, () => get('https://x/contracts'))).edge).toBe('HIT');
    expect(rendered).toHaveLength(1);
    // Not for ever: writers that leave no stamp are picked up at the cap.
    expect((await later(SAME_DATA_SECONDS, () => get('https://x/contracts'))).edge).toBe('MISS');
  });

  it('renders an expired page again once the data generation has changed', async () => {
    data.generation = 'refresh-1|publish-1';
    await get('https://x/contracts');
    data.generation = 'refresh-2|publish-1';
    // Within the route's own freshness the page is served as before; past it, it is rendered anew.
    expect((await later(1799, () => get('https://x/contracts'))).edge).toBe('HIT');
    expect((await later(1801, () => get('https://x/contracts'))).edge).toBe('MISS');
  });

  it('takes an unknown data generation as proof of nothing', async () => {
    data.generation = 'refresh-1|publish-1';
    await get('https://x/contracts');
    data.generation = null;
    expect((await later(1801, () => get('https://x/contracts'))).edge).toBe('MISS');

    // Rendered while the generation was unknown: nothing vouches for it later either.
    data.generation = 'refresh-1|publish-1';
    expect((await later(2 * 1801, () => get('https://x/contracts'))).edge).toBe('MISS');
  });

  it('lets none of its notes on a stored page out of the worker', async () => {
    data.generation = 'refresh-1|publish-1';
    expect(notes((await get('https://x/contracts')).headers)).toEqual([]);
    expect(notes((await get('https://x/contracts')).headers)).toEqual([]);
    const conditional = await get('https://x/contracts', 'GET', { 'If-None-Match': '"test-v1"' });
    expect(conditional.status).toBe(304);
    expect(notes(conditional.headers)).toEqual([]);
    reply.status = 503;
    data.generation = null;
    const stale = await later(1801, () => get('https://x/contracts'));
    expect(stale.edge).toBe('STALE');
    expect(notes(stale.headers)).toEqual([]);
  });

  it('gives each render a D1 session of its own, and opens none for a page it has stored', async () => {
    const sessions: string[] = [];
    const DB = {
      withSession: (constraint: string) => {
        const n = sessions.push(constraint);
        return { prepare: () => `statement of session ${n}` };
      },
    };
    const env = { DB, OTHER: 'binding' };
    await get('https://x/contracts', 'GET', undefined, env);
    await get('https://x/contracts?bids=1', 'GET', undefined, env);
    expect(sessions).toEqual(['first-unconstrained', 'first-unconstrained']);
    // The render reads through its session; every other binding is the worker's own.
    const handed = envs as { DB: { prepare: (q: string) => unknown }; OTHER: string }[];
    expect(handed.map((e) => e.DB.prepare('SELECT 1'))).toEqual([
      'statement of session 1',
      'statement of session 2',
    ]);
    expect(handed.map((e) => e.OTHER)).toEqual(['binding', 'binding']);

    expect((await get('https://x/contracts', 'GET', undefined, env)).edge).toBe('HIT');
    expect(sessions).toHaveLength(2);
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
