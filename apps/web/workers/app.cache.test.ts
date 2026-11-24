import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '@sigma/db';
import { fakeD1 } from '@sigma/test-support';
import { FOLLOWER_WAIT_MS } from './render-gate';

// Every request the stubbed React Router handler (the loaders) receives; while `held.gate` is set, every
// render waits on it, as for a slow D1.
const rendered = vi.hoisted(() => [] as Request[]);
// The env each render was handed, in the same order.
const envs = vi.hoisted(() => [] as { DB?: unknown }[]);
const held = vi.hoisted(() => ({ gate: null as Promise<void> | null }));
const reply = vi.hoisted(() => ({
  status: 200,
  throws: false,
  policy: null as string | null,
  broken: false,
  custom: null as ((request: Request, env: { DB: D1Database }) => Promise<Response>) | null,
}));
const limiter = vi.hoisted(() => ({ refusal: null as Response | null }));

// Exercises the REAL edge-cache middleware in app.ts (handleRequest -> cacheKey -> edgeCache
// match/put) without the SSR build or D1, to gate that app.ts actually keys the cache by cacheKey.
// The pure cacheKey test proves keys differ; this proves the middleware USES that key, so a
// /contracts?bids=1 response can never be served for /contracts (CWE-349, #56).

// Stub the React Router handler: the two URLs return DIFFERENT bodies — the whole reason `bids`
// must be in the cache key. The import thunk is never invoked, so no real build is loaded.
vi.mock('react-router', () => ({
  createRequestHandler:
    () => async (request: Request, context: { cloudflare: { env: { DB: D1Database } } }) => {
      rendered.push(request);
      envs.push(context.cloudflare.env);
      const { status, throws, policy, broken, custom } = reply;
      if (held.gate) await held.gate;
      if (throws) throw new Error('render failed');
      if (custom) return custom(request, context.cloudflare.env);
      const url = new URL(request.url);
      if (broken) {
        const body = new ReadableStream({
          start(controller) {
            controller.error(new Error('HTML stream failed'));
          },
        });
        return new Response(body, {
          headers: {
            'Cache-Control': 'public, s-maxage=1800',
            'Content-Type': 'text/html',
            'Content-Security-Policy': "script-src 'nonce-synthetic'",
          },
        });
      }
      if (status !== 200) {
        return new Response('Temporary failure', {
          status,
          headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, s-maxage=1800' },
        });
      }
      // A designated path returns 404, to exercise the response.ok cache-put gate (see the „non-ok" test).
      if (['/contracts/missing', '/contracts/test/contract'].includes(url.pathname)) {
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
            : url.pathname.endsWith('.json') || url.pathname === '/search/suggest'
              ? 'application/json'
              : 'text/html; charset=utf-8',
          'Cache-Control':
            policy ??
            (url.pathname === '/search/suggest'
              ? 'public, s-maxage=120, stale-while-revalidate=86400'
              : url.pathname === '/search'
                ? 'public, s-maxage=300, stale-while-revalidate=86400'
                : 'public, s-maxage=1800'),
          'Content-Length': String(body.length),
          ETag: '"test-v1"',
          'Last-Modified': 'Sat, 01 Jan 2000 00:00:00 GMT',
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
vi.mock('./csv-rate-limit', () => ({ rateLimitCsvExport: async () => null }));
vi.mock('./search-rate-limit', () => ({ rateLimitSearchRoute: async () => null }));

// Minimal stand-in for caches.default (Cloudflare Cache API), keyed by the cache-key URL.
function makeFakeCache() {
  const store = new Map<
    string,
    {
      body: string;
      status: number;
      statusText: string;
      headers: [string, string][];
      expires: number;
    }
  >();
  return {
    store,
    async match(req: Request | string) {
      const url = typeof req === 'string' ? req : req.url;
      const e = store.get(url);
      if (e && Date.now() >= e.expires) {
        store.delete(url);
        return undefined;
      }
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
        if (req.headers.get('Range') === 'bytes=0-3') {
          headers.set('Content-Range', `bytes 0-3/${e.body.length}`);
          headers.set('Content-Length', '4');
          return new Response(e.body.slice(0, 4), { status: 206, headers });
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
    async delete(req: Request | string) {
      return store.delete(typeof req === 'string' ? req : req.url);
    },
    async put(req: Request | string, res: Response) {
      const url = typeof req === 'string' ? req : req.url;
      const ttl = Number(/s-maxage=(\d+)/.exec(res.headers.get('Cache-Control') ?? '')?.[1]);
      store.set(url, {
        body: await res.text(),
        expires: Date.now() + ttl * 1000,
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
  reply.policy = null;
  reply.broken = false;
  reply.custom = null;
  limiter.refusal = null;
  vi.stubEnv('DEV', false);
});

async function get(
  url: string,
  method = 'GET',
  headers?: Record<string, string>,
  env: unknown = {},
  signal?: AbortSignal,
) {
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void waits.push(p),
    passThroughOnException: () => {},
  };
  const res = await worker.fetch(new Request(url, { method, headers, signal }), env, ctx);
  const body = await res.clone().text();
  await Promise.all(waits); // let edgeCache.put (ctx.waitUntil) settle before the next request
  return { edge: res.headers.get('X-Edge-Cache'), body, status: res.status, headers: res.headers };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe('app.ts edge cache middleware', () => {
  it.each([
    ['full snapshot', {}],
    ['conditional snapshot', { 'If-None-Match': '"test-v1"' }],
    ['range snapshot', { Range: 'bytes=0-3' }],
  ] as const)(
    'rejects a delayed %s after a successful withdrawal delete',
    async (_label, headers) => {
      const url = 'https://x/persons/test-person';
      await get(url);
      const match = fakeCache.match.bind(fakeCache);
      const captured = deferred();
      const resume = deferred();
      const matches = vi.spyOn(fakeCache, 'match');
      if (Object.keys(headers).length) matches.mockImplementationOnce(match);
      matches
        .mockImplementationOnce(async (request) => {
          const snapshot = await match(request);
          captured.resolve();
          await resume.promise;
          return snapshot;
        })
        .mockResolvedValueOnce(undefined);
      try {
        const delayed = get(url, 'GET', headers);
        await captured.promise;
        reply.status = 410;
        expect((await get(url)).status).toBe(410);
        expect(fakeCache.store.size).toBe(0);
        reply.status = 503;
        resume.resolve();
        const result = await delayed;
        expect(result.status).toBe(503);
        expect(result.edge).toBe('BYPASS');
      } finally {
        resume.resolve();
        vi.restoreAllMocks();
      }
    },
  );

  it('does not return a fresh positive after the withdrawal delete rejects', async () => {
    const url = 'https://x/persons/failed-delete.data';
    await get(url);
    vi.spyOn(fakeCache, 'match').mockResolvedValueOnce(undefined);
    vi.spyOn(fakeCache, 'delete').mockRejectedValueOnce(new Error('Cache API failure'));
    try {
      reply.status = 410;
      expect((await get(url)).status).toBe(410);
      expect(fakeCache.store.size).toBe(1);
      reply.status = 503;
      const result = await get(url);
      expect(result.status).toBe(503);
      expect(result.edge).toBe('BYPASS');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([200, 410])('delivers an unsuperseded %i owner after eleven seconds', async (status) => {
    vi.useFakeTimers();
    const load = deferred();
    try {
      reply.status = status;
      held.gate = load.promise;
      const owner = get('https://x/persons/slow-owner.data');
      await vi.advanceTimersByTimeAsync(11_000);
      expect(rendered).toHaveLength(1);
      load.resolve();
      const response = await owner;
      expect(response.status).toBe(status);
      expect(response.edge).toBe(status === 200 ? 'MISS' : 'BYPASS');
    } finally {
      load.resolve();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it.each(['silent put drop', 'withdrawal'])('bounds cohort renders on %s', async (mode) => {
    const url = 'https://x/persons/burst.data';
    const load = deferred();
    held.gate = load.promise;
    if (mode === 'silent put drop') {
      vi.spyOn(fakeCache, 'put').mockImplementation(async (_key, response) => {
        await response.text();
      });
    } else {
      reply.status = 410;
    }
    try {
      const cohort = Promise.all(Array.from({ length: 9 }, () => get(url)));
      await vi.waitFor(() => expect(rendered).toHaveLength(1));
      held.gate = null;
      load.resolve();
      const responses = await cohort;
      expect(rendered).toHaveLength(2);
      expect(responses.filter((response) => response.status === 503)).toHaveLength(7);
      expect(
        responses.filter((response) => response.status === (mode === 'withdrawal' ? 410 : 200)),
      ).toHaveLength(2);
      vi.restoreAllMocks();
      reply.status = 200;
      expect((await get(url)).edge).toBe('MISS');
      expect((await get(url)).edge).toBe('HIT');
    } finally {
      load.resolve();
      vi.restoreAllMocks();
    }
  });

  it('rerenders when an eviction lands between the full and conditional lookups', async () => {
    await get('https://x/contracts');
    const match = fakeCache.match.bind(fakeCache);
    vi.spyOn(fakeCache, 'match')
      .mockImplementationOnce(match)
      .mockImplementationOnce(async () => {
        fakeCache.store.clear();
        return undefined;
      });
    reply.status = 404;
    const conditional = await get('https://x/contracts', 'GET', { 'If-None-Match': '"test-v1"' });
    expect(conditional.status).toBe(404);
    expect(conditional.headers.get('Cache-Control')).toBe('no-store');
    expect(rendered).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it('releases the full response when a conditional cache lookup rejects', async () => {
    const url = 'https://x/persons/conditional-error';
    await get(url);
    const match = fakeCache.match.bind(fakeCache);
    const copy = await match([...fakeCache.store.keys()][0]!);
    const cancel = vi.spyOn(copy!.body!, 'cancel');
    vi.spyOn(fakeCache, 'match')
      .mockResolvedValueOnce(copy)
      .mockRejectedValueOnce(new Error('synthetic conditional cache failure'));
    try {
      reply.status = 503;
      expect((await get(url, 'GET', { 'If-None-Match': '"test-v1"' })).status).toBe(503);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([
    ['GET', 'If-None-Match', '"test-v1"'],
    ['HEAD', 'If-None-Match', '"test-v1"'],
    ['GET', 'If-Modified-Since', 'Sat, 01 Jan 2000 00:00:00 GMT'],
    ['HEAD', 'If-Modified-Since', 'Sat, 01 Jan 2000 00:00:00 GMT'],
  ])('keeps browser revalidation on a conditional %s using %s', async (method, name, value) => {
    await get('https://x/contracts');
    const conditional = await get('https://x/contracts', method, { [name]: value });
    expect(conditional.status).toBe(304);
    expect(conditional.edge).toBe('HIT');
    expect(conditional.body).toBe('');
    expect(conditional.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(rendered).toHaveLength(1);
    const stored = [...fakeCache.store.values()][0]!.headers;
    expect(stored).toContainEqual(['cache-control', 'public, s-maxage=1800']);
    expect([...conditional.headers.keys()].some((name) => name.startsWith('x-sigma-'))).toBe(false);
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
      expect(stored).toContainEqual(['cache-control', 'public, s-maxage=1800']);
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
  it.each([
    ['/persons/test-person?view=profile', 1800],
    ['/persons/test-person.data?view=profile', 1800],
    ['/conflicts/link/test/test-link/test-company/contracts', 1800],
    ['/search?q=synthetic', 300],
    ['/search.data?q=synthetic', 1800],
    ['/search/suggest?q=synthetic', 120],
    ['/companies/test-company', 1800],
    ['/authorities/test-authority.data', 1800],
    ['/network.data?center=a:test-authority', 1800],
  ])('never serves stale data from %s after the route TTL', async (path, ttl) => {
    const url = 'https://x' + path;
    const warmed = await get(url);
    expect(warmed.status).toBe(200);
    expect((await later(ttl - 1, () => get(url))).edge).toBe('HIT');
    reply.status = 503;
    const failed = await later(ttl, () => get(url));
    expect(failed.status).toBe(503);
    expect(failed.headers.get('Cache-Control')).toBe('no-store');
    expect(failed.body).not.toBe(warmed.body);
    expect(fakeCache.store.size).toBe(0);

    limiter.refusal = new Response('Too many', { status: 429 });
    const limited = await later(ttl + 1, () => get(url));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Cache-Control')).toBe('no-store');
    expect(rendered).toHaveLength(2);
  });

  it.each(['503', 'throw', 'HTML stream error'])(
    'coalesces failed refreshes (%s) and lets the next request recover',
    async (failure) => {
      const url = 'https://x/persons/test-person';
      await get(url);
      reply.status = failure === '503' ? 503 : 200;
      reply.throws = failure === 'throw';
      reply.broken = failure === 'HTML stream error';
      await later(1801, async () => {
        let release!: () => void;
        held.gate = new Promise((resolve) => (release = resolve));
        const cohort = Array.from({ length: 8 }, () => get(url));
        await vi.waitFor(() => expect(rendered).toHaveLength(2));
        held.gate = null;
        release();
        for (const response of await Promise.all(cohort)) {
          expect(response.status).toBe(failure === '503' ? 503 : 500);
          expect(response.headers.get('Cache-Control')).toBe('no-store');
        }
        expect(rendered).toHaveLength(2);
        expect(fakeCache.store.size).toBe(0);
        reply.status = 200;
        reply.throws = false;
        reply.broken = false;
        expect((await get(url)).edge).toBe('MISS');
      });
    },
  );

  it('releases a rejected cache write and settles followers without a recovery render', async () => {
    vi.useFakeTimers();
    const url = 'https://x/persons/rejected-put.data';
    const load = deferred();
    const reject = deferred();
    const cancel = vi.fn();
    const put = vi.spyOn(fakeCache, 'put').mockImplementationOnce(async (_key, response) => {
      vi.spyOn(response.body!, 'cancel').mockImplementation(async () => cancel());
      await reject.promise;
      throw new Error('synthetic cache write failure');
    });
    try {
      held.gate = load.promise;
      const owner = get(url);
      const follower = get(url);
      await vi.advanceTimersByTimeAsync(0);
      expect(rendered).toHaveLength(1);
      load.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(put).toHaveBeenCalledOnce();
      reject.resolve();
      expect((await owner).status).toBe(200);
      expect((await follower).status).toBe(500);
      expect(cancel).toHaveBeenCalledOnce();
      expect(rendered).toHaveLength(1);
      expect((await get(url)).edge).toBe('MISS');
    } finally {
      load.resolve();
      reject.resolve();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('rejects a physically stored copy when a late put has exhausted its serving TTL', async () => {
    vi.useFakeTimers();
    const store = deferred();
    const put = fakeCache.put.bind(fakeCache);
    vi.spyOn(fakeCache, 'put').mockImplementationOnce(async (key, response) => {
      await store.promise;
      await put(key, response);
    });
    try {
      const url = 'https://x/persons/late-expiry.data';
      reply.policy = 'public, s-maxage=60';
      const old = get(url);
      await vi.advanceTimersByTimeAsync(60_000);
      store.resolve();
      expect((await old).edge).toBe('MISS');
      expect(fakeCache.store.size).toBe(1);
      reply.status = 503;
      expect((await get(url)).status).toBe(503);
    } finally {
      store.resolve();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('delivers a slow render without storing it when its freshness expired before the put', async () => {
    vi.useFakeTimers();
    const load = deferred();
    const put = vi.spyOn(fakeCache, 'put');
    try {
      const url = 'https://x/contracts/expired-before-put';
      reply.policy = 'public, s-maxage=1';
      held.gate = load.promise;
      const pending = get(url);
      await vi.advanceTimersByTimeAsync(0);
      expect(rendered).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      load.resolve();

      const result = await pending;
      expect(result.status).toBe(200);
      expect(result.body).toBe('ROWS: all contracts (5)');
      expect(result.edge).toBe('BYPASS');
      expect(result.headers.get('Cache-Control')).toBe('no-store');
      expect(put).not.toHaveBeenCalled();
      expect((await get(url)).edge).toBe('MISS');
      expect(rendered).toHaveLength(2);
    } finally {
      load.resolve();
      vi.useRealTimers();
      put.mockRestore();
    }
  });

  it('serves a private session response without replacing or evicting the shared entry', async () => {
    const url = 'https://x/contracts/session-fixture';
    const publicPage = await get(url);
    const match = vi.spyOn(fakeCache, 'match').mockResolvedValueOnce(undefined);
    const remove = vi.spyOn(fakeCache, 'delete');
    try {
      reply.custom = async () =>
        new Response('Session-only content', {
          headers: {
            'Content-Type': 'text/html',
            'Cache-Control': 'private, no-store',
            'Set-Cookie': 'fixture-session=assigned; Secure; HttpOnly',
          },
        });
      const personal = await get(url);
      expect(personal.edge).toBe('BYPASS');
      expect(personal.body).toBe('Session-only content');
      expect(personal.headers.get('Cache-Control')).toBe('private, no-store');
      expect(personal.headers.get('Set-Cookie')).toContain('fixture-session=assigned');
      expect(remove).not.toHaveBeenCalled();
      const shared = await get(url);
      expect(shared.edge).toBe('HIT');
      expect(shared.body).toBe(publicPage.body);
      expect(shared.headers.has('Set-Cookie')).toBe(false);
    } finally {
      match.mockRestore();
      remove.mockRestore();
    }
  });

  it('elects one successor after an owner disconnects and fences its late positive', async () => {
    const url = 'https://x/persons/disconnected.data';
    const load = deferred();
    const controller = new AbortController();
    held.gate = load.promise;
    const old = get(url, 'GET', undefined, {}, controller.signal);
    try {
      await vi.waitFor(() => expect(rendered).toHaveLength(1));
      held.gate = null;
      reply.status = 410;
      controller.abort();
      expect((await get(url)).status).toBe(410);
      load.resolve();
      expect((await old).status).toBe(503);
      expect(rendered).toHaveLength(2);
      expect(fakeCache.store.size).toBe(0);
    } finally {
      load.resolve();
    }
  });

  it('times out a waiting cohort without replacing a healthy render', async () => {
    vi.useFakeTimers();
    const load = deferred();
    try {
      const url = 'https://x/search.data?q=slow-fixture';
      held.gate = load.promise;
      const owner = get(url);
      await vi.advanceTimersByTimeAsync(0);
      const followers = Array.from({ length: 8 }, () => get(url));
      await vi.advanceTimersByTimeAsync(FOLLOWER_WAIT_MS);
      expect((await Promise.all(followers)).map((r) => r.status)).toEqual(Array(8).fill(503));
      expect(rendered).toHaveLength(1);
      load.resolve();
      expect((await owner).status).toBe(200);
      expect((await get(url)).edge).toBe('HIT');
    } finally {
      load.resolve();
      vi.useRealTimers();
    }
  });

  it('rejects a lookup started before an outstanding put even after its cleanup finishes', async () => {
    vi.useFakeTimers();
    const put = fakeCache.put.bind(fakeCache);
    const remove = fakeCache.delete.bind(fakeCache);
    const match = fakeCache.match.bind(fakeCache);
    const startSnapshot = deferred();
    const captured = deferred();
    const resumeSnapshot = deferred();
    const resumePut = deferred();
    const resumeCleanup = deferred();
    vi.spyOn(fakeCache, 'match').mockImplementationOnce(async (key) => {
      await startSnapshot.promise;
      const copy = await match(key);
      if (copy) captured.resolve();
      await resumeSnapshot.promise;
      return copy;
    });
    vi.spyOn(fakeCache, 'delete')
      .mockImplementationOnce(remove)
      .mockImplementationOnce(async (key) => {
        await resumeCleanup.promise;
        return remove(key);
      });
    vi.spyOn(fakeCache, 'put').mockImplementationOnce(async (key, response) => {
      await resumePut.promise;
      await put(key, response);
    });
    try {
      const url = 'https://x/persons/pending-put.data';
      const delayed = get(url);
      await vi.advanceTimersByTimeAsync(0);
      const old = get(url);
      await vi.advanceTimersByTimeAsync(FOLLOWER_WAIT_MS);
      reply.status = 410;
      expect((await get(url)).status).toBe(410);
      resumePut.resolve();
      await vi.waitFor(() => expect(fakeCache.store.size).toBe(1));
      startSnapshot.resolve();
      await captured.promise;
      resumeCleanup.resolve();
      expect((await old).edge).toBe('MISS');
      expect(fakeCache.store.size).toBe(0);
      reply.status = 503;
      resumeSnapshot.resolve();
      expect((await delayed).status).toBe(503);
    } finally {
      startSnapshot.resolve();
      resumeSnapshot.resolve();
      resumePut.resolve();
      resumeCleanup.resolve();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('does not serve the superseded copy if cleanup of a delayed put fails', async () => {
    vi.useFakeTimers();
    const url = 'https://x/persons/failed-put-cleanup.data';
    const resumePut = deferred();
    const started = deferred();
    const put = fakeCache.put.bind(fakeCache);
    const remove = fakeCache.delete.bind(fakeCache);
    const putSpy = vi.spyOn(fakeCache, 'put').mockImplementationOnce(async (key, response) => {
      started.resolve();
      await resumePut.promise;
      await put(key, response);
    });
    const removeSpy = vi
      .spyOn(fakeCache, 'delete')
      .mockImplementationOnce(remove)
      .mockRejectedValueOnce(new Error('Cache API cleanup failure'));
    try {
      const old = get(url);
      await started.promise;
      await vi.advanceTimersByTimeAsync(FOLLOWER_WAIT_MS);
      reply.status = 410;
      expect((await get(url)).status).toBe(410);

      resumePut.resolve();
      await old;
      expect(removeSpy).toHaveBeenCalledTimes(2);
      expect(fakeCache.store.size).toBe(1);

      reply.status = 503;
      const next = await get(url);
      expect(next.status).toBe(503);
      expect(next.edge).toBe('BYPASS');
      expect(next.headers.get('Cache-Control')).toBe('no-store');
    } finally {
      resumePut.resolve();
      putSpy.mockRestore();
      removeSpy.mockRestore();
      vi.useRealTimers();
    }
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

  it('discards a conditional reply when the Cache API drops its entry identity', async () => {
    const url = 'https://x/contracts/test.json';
    await get(url);
    const match = fakeCache.match.bind(fakeCache);
    vi.spyOn(fakeCache, 'match')
      .mockImplementationOnce(match)
      .mockImplementationOnce(
        async () =>
          new Response(null, {
            status: 304,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'public, s-maxage=108000',
            },
          }),
      );
    reply.status = 503;
    const result = await get(url, 'GET', { 'If-None-Match': '"test-v1"' });
    expect(result.status).toBe(503);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    vi.restoreAllMocks();
  });

  it('serves a range from the same verified entry with the route browser policy', async () => {
    const url = 'https://x/contracts/test.json';
    const first = await get(url);
    const range = await get(url, 'GET', { Range: 'bytes=0-3' });
    expect(range.status).toBe(206);
    expect(range.edge).toBe('HIT');
    expect(range.body).toBe(first.body.slice(0, 4));
    expect(range.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(range.headers.get('Content-Range')).toBe(`bytes 0-3/${first.body.length}`);
    expect(range.headers.has('X-Sigma-Cache-Entry')).toBe(false);
    expect(rendered).toHaveLength(1);
  });

  it.each([404, 410, 302, 202, 200])(
    'evicts exactly the canonical variant for an authoritative %i or no-store',
    async (status) => {
      const data = status === 202 || status === 200 ? '.data' : '';
      const url = `https://x/persons/test-person${data}?year=2012`;
      const other = `https://x/persons/test-person${data}?year=2013`;
      await get(url);
      await get(other);
      // Force a reload while the earlier positive is still present in Cache API storage.
      vi.spyOn(fakeCache, 'match').mockResolvedValueOnce(undefined);
      reply.status = status;
      if (status === 200) {
        reply.custom = async () =>
          new Response('corrected fixture', {
            headers: { 'Cache-Control': 'public, no-store, s-maxage=1800' },
          });
      }
      const withdrawn = await get(url + '&ignored=1');
      expect(withdrawn.status).toBe(status);
      expect(withdrawn.edge).toBe('BYPASS');
      expect(withdrawn.headers.get('Cache-Control')).toBe('no-store');
      if (status === 200) expect(withdrawn.body).toBe('corrected fixture');
      reply.custom = null;
      expect(fakeCache.store.size).toBe(1);
      expect((await get(other)).edge).toBe('HIT');
      reply.status = 503;
      const failed = await get(url);
      expect(failed.status).toBe(503);
      expect(failed.headers.get('Cache-Control')).toBe('no-store');
      vi.restoreAllMocks();
    },
  );

  it('uses the primary on a cold miss even with a lagging replica and no publication table', async () => {
    const query = 'SELECT state FROM synthetic_records';
    let state = 'published fixture';
    const primary = fakeD1([{ when: query, first: () => ({ state }) }]);
    const replica = fakeD1([
      { when: query, first: { state: 'published fixture' } },
      {
        when: 'rp_generation',
        first: () => {
          throw new Error('no such table: rp_generation');
        },
      },
    ]);
    const DB = Object.assign(primary.db, {
      withSession: vi.fn(() => ({
        prepare: replica.db.prepare.bind(replica.db),
        batch: replica.db.batch.bind(replica.db),
        getBookmark: () => null,
      })),
    });
    reply.custom = async (_request, env) => {
      const row = await getDb(env).prepare(query).first<{ state: string }>();
      return new Response(row!.state, {
        status: row!.state === 'gone' ? 404 : 200,
        headers: { 'Cache-Control': 'public, s-maxage=1800' },
      });
    };
    const urls = [
      '/',
      '/_root.data',
      '/analytics',
      '/analytics.data',
      '/competition',
      '/competition.data',
      '/flows',
      '/flows.data',
      '/persons/test-person',
      '/persons/test-person.data?year=2012',
      '/search?q=synthetic',
      '/search/suggest?q=synthetic',
      '/companies/test-company.data',
      '/authorities/test-authority',
      '/network?center=c:test-company',
    ];
    for (const path of urls)
      expect((await get('https://x' + path, 'GET', undefined, { DB })).status).toBe(200);
    state = 'gone';
    fakeCache.store.clear();
    for (const path of urls) {
      const response = await get('https://x' + path, 'GET', undefined, { DB });
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(fakeCache.store.size).toBe(0);
    expect(DB.withSession).not.toHaveBeenCalled();
    expect(primary.sql).toEqual(Array(urls.length * 2).fill(query));
    expect(replica.calls).toEqual([]);
  });

  it.each(['missing publication table', 'failed probe', 'out-of-order probes'])(
    'keeps route freshness independent of generation reads (%s)',
    async (scenario) => {
      const probes: Array<() => void> = [];
      let probeCount = 0;
      const DB = {
        withSession: () => ({
          prepare: (sql: string) => {
            if (!sql.includes('rp_generation')) throw new Error('Unexpected query in fixture');
            probeCount++;
            return {
              first: async () => {
                if (scenario === 'missing publication table')
                  throw new Error('no such table: rp_generation');
                if (probeCount > 1 && scenario === 'failed probe')
                  throw new Error('D1 unavailable');
                const refreshed = probeCount === 1 ? '2000-01-01 00:00:00' : '2000-01-02 00:00:00';
                if (probeCount > 1) await new Promise<void>((resolve) => probes.push(resolve));
                return { refreshed, published: null };
              },
            };
          },
        }),
      };
      const waits: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
      const env = { DB };
      const fixture = 'https://x/competition';
      reply.policy = 'public, s-maxage=120';
      await get('https://x/', 'GET', undefined, env);
      await get(fixture, 'GET', undefined, env);

      await later(121, async () => {
        reply.status = 503;
        const first = await worker.fetch(new Request(fixture), env, ctx);
        vi.setSystemTime(Date.now() + 61_000);
        const next = await worker.fetch(new Request(fixture), env, ctx);
        for (const release of probes.reverse()) release();
        await Promise.all(waits);
        expect([first.status, next.status]).toEqual([503, 503]);
        expect(first.headers.get('Cache-Control')).toBe('no-store');
        expect(probeCount).toBe(0);
      });
    },
  );

  it('opens a session per eligible render, with no generation read and none on a hit', async () => {
    const sessions: string[] = [];
    const DB = {
      withSession: (constraint: string) => {
        const n = sessions.push(constraint);
        return { prepare: () => `statement of session ${n}` };
      },
    };
    const env = { DB, OTHER: 'binding' };
    await get('https://x/trends', 'GET', undefined, env);
    await get('https://x/trends.data?sector=45', 'GET', undefined, env);
    expect(sessions).toEqual(['first-unconstrained', 'first-unconstrained']);
    const handed = envs as { DB: { prepare: (q: string) => unknown }; OTHER: string }[];
    expect(handed.map((e) => e.DB.prepare('SELECT 1'))).toEqual([
      'statement of session 1',
      'statement of session 2',
    ]);
    expect(handed.map((e) => e.OTHER)).toEqual(['binding', 'binding']);

    expect((await get('https://x/trends', 'GET', undefined, env)).edge).toBe('HIT');
    expect(sessions).toHaveLength(2);
  });

  it.each([
    [{ Cookie: 'synthetic=1' }, 'public, s-maxage=1800'],
    [{ Authorization: 'Bearer fixture' }, 'public, s-maxage=1800'],
    [{ Cookie: 'synthetic=1' }, 'public, max-age=1800'],
  ] as const)(
    'bypasses shared and downstream caching on a credentialed response',
    async (headers, policy) => {
      const url = 'https://x/persons/test-person';
      const anonymous = await get(url);
      const match = vi.spyOn(fakeCache, 'match');
      const put = vi.spyOn(fakeCache, 'put');
      const remove = vi.spyOn(fakeCache, 'delete');
      try {
        reply.custom = async () =>
          new Response('credentialed fixture', {
            headers: { 'Content-Type': 'text/html', 'Cache-Control': policy },
          });
        const credentialed = await get(url, 'GET', headers);
        expect(credentialed.edge).toBe('BYPASS');
        expect(credentialed.headers.get('Cache-Control')).toBe('no-store');
        expect(credentialed.body).toBe('credentialed fixture');
        expect(match).not.toHaveBeenCalled();
        expect(put).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        const hit = await get(url);
        expect(hit.edge).toBe('HIT');
        expect(hit.body).toBe(anonymous.body);
        expect(rendered).toHaveLength(2);
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it('preserves a resource policy that only sets browser freshness', async () => {
    reply.custom = async () =>
      new Response('fixture', { headers: { 'Cache-Control': 'public, max-age=86400' } });
    const result = await get('https://x/robots.txt');
    expect(result.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect(result.edge).toBe('BYPASS');
    expect(fakeCache.store.size).toBe(0);
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

  it('never reads or evicts an encoded-slash 200 when the raw-slash route returns 404', async () => {
    const encoded = 'https://x/contracts/test%2Fcontract';
    const raw = 'https://x/contracts/test/contract';
    const first = await get(encoded);
    expect(first.status).toBe(200);
    expect(first.edge).toBe('MISS');
    const missing = await get(raw);
    expect(missing.status).toBe(404);
    expect(missing.edge).toBe('BYPASS');
    expect((await get(encoded)).edge).toBe('HIT');
    expect(rendered).toHaveLength(2);
    expect(fakeCache.store.size).toBe(1);
  });
});
