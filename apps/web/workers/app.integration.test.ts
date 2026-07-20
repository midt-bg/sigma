import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Integration proof for the .data single-fetch limiter fix (#184): drive the REAL worker
// `handleRequest` chain end-to-end and assert that an over-limit `/<path>.data` twin is rejected
// with 429 BEFORE React Router's (expensive, D1-backed) loader is ever invoked. Only RR's server
// build is mocked — every limiter, the cache-key computation, the edge-cache lookup, and their
// ordering in app.ts run for real. This is the rung the pure-node unit tests can't reach: it proves
// the loader-unreached property through the actual request pipeline, not the classifier in isolation.

// The RR handler is the thing that runs the loader/D1 query. Replace createRequestHandler with a spy
// so we can assert it is NOT called on the throttled path (and IS called when under the limit).
const rrLoader = vi.fn(async () => new Response('LOADER RAN', { status: 200 }));
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  createRequestHandler: () => rrLoader,
}));
// The virtual server build is only imported lazily by the real handler (which we've replaced), but
// stub it so vitest never tries to resolve the Vite virtual module during transform.
vi.mock('virtual:react-router/server-build', () => ({ default: {} }));

// app.ts reads `caches.default` at module-init, so the global must exist before it is imported.
const cacheStore = { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) };
(globalThis as unknown as { caches: unknown }).caches = { default: cacheStore };

// A limiter binding that always reports the key is over the limit (deterministic — the real binding
// is external infra; stubbing it is exactly what the unit specs do). `success:false` ⇒ 429.
const overLimit = { limit: vi.fn(async () => ({ success: false })) } as unknown as RateLimit;
const underLimit = { limit: vi.fn(async () => ({ success: true })) } as unknown as RateLimit;

const env = (limiter: RateLimit) =>
  ({
    SEARCH_RATE_LIMITER: limiter,
    AGG_RATE_LIMITER: limiter,
    CSV_RATE_LIMITER: limiter,
    ASSISTANT_RATE_LIMITER: limiter,
  }) as unknown as Env;

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

// app.ts's default `fetch` uses the strict ExportedHandler signature (Request<…IncomingRequestCf…>);
// this test drives it with plain `new Request()`s, so bind a loosened callable via the module default.
type WorkerFetch = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
let workerFetch: WorkerFetch;

beforeAll(async () => {
  workerFetch = (await import('./app')).default.fetch as unknown as WorkerFetch;
});

afterEach(() => {
  rrLoader.mockClear();
  cacheStore.match.mockClear();
  cacheStore.put.mockClear();
});

// The four limited single-fetch twins, each exercised through the full pipeline.
const twins: Array<{ name: string; method: string; url: string }> = [
  { name: 'search', method: 'GET', url: 'http://local/search.data?q=eon' },
  { name: 'aggregation /companies', method: 'GET', url: 'http://local/companies.data' },
  { name: 'aggregation /authorities', method: 'GET', url: 'http://local/authorities.data' },
  { name: 'csv', method: 'GET', url: 'http://local/contracts.csv.data' },
  { name: 'assistant', method: 'POST', url: 'http://local/assistant/chat.data' },
];

describe('handleRequest — .data twins are throttled before the loader runs (#184)', () => {
  for (const { name, method, url } of twins) {
    it(`429s the over-limit ${name} .data twin and never invokes the RR loader`, async () => {
      const req = new Request(url, { method, headers: { 'CF-Connecting-IP': '203.0.113.99' } });
      const res = await workerFetch(req, env(overLimit), ctx);

      expect(res.status, `${url} should be throttled`).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('60');
      // The critical property: the D1-backed loader was short-circuited, not merely rate-accounted.
      expect(rrLoader, `${url} must not reach the loader`).not.toHaveBeenCalled();
    });
  }

  it('lets an under-limit /search.data twin through to the loader (no over-blocking)', async () => {
    const req = new Request('http://local/search.data?q=eon', {
      headers: { 'CF-Connecting-IP': '203.0.113.98' },
    });
    const res = await workerFetch(req, env(underLimit), ctx);

    expect(res.status).toBe(200);
    expect(rrLoader).toHaveBeenCalledTimes(1);
  });

  it('reaches the search limiter only after an edge-cache MISS on the .data twin', async () => {
    // Ordering guard: agg/search/assistant limiters run AFTER the cache lookup in handleRequest, so a
    // GET .data twin must miss the cache (match → undefined) and still get throttled.
    const req = new Request('http://local/companies.data', {
      headers: { 'CF-Connecting-IP': '203.0.113.97' },
    });
    const res = await workerFetch(req, env(overLimit), ctx);

    expect(cacheStore.match).toHaveBeenCalledTimes(1); // cache was consulted
    expect(res.status).toBe(429); // and the limiter still fired on the miss
    expect(rrLoader).not.toHaveBeenCalled();
  });
});
