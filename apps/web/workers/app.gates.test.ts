import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The worker around React Router, on the paths the other app.* suites leave out: it hands the router its
// server build lazily, sends cleartext HTTP to HTTPS in production before any other gate, keys the edge cache
// under the build's deploy tag, throttles the person pages before their loaders run, and does not take a
// response without a Content-Type for HTML. The real limiters run; only the router and the log are stubbed.
const rr = vi.hoisted(() => ({
  loadBuild: null as null | (() => Promise<unknown>),
  mode: undefined as unknown,
  handler: vi.fn(async (_request: Request) => new Response(null, { status: 204 })),
}));
vi.mock('react-router', () => ({
  createRequestHandler: (loadBuild: () => Promise<unknown>, mode: unknown) => {
    rr.loadBuild = loadBuild;
    rr.mode = mode;
    return rr.handler;
  },
}));
vi.mock('virtual:react-router/server-build', () => ({ routes: { root: { id: 'root' } } }));
vi.mock('./request-log', () => ({
  withRequestLog: (
    request: Request,
    env: unknown,
    ctx: unknown,
    handler: (r: Request, e: unknown, c: unknown) => Promise<Response>,
  ) => handler(request, env, ctx),
}));

type WorkerFetch = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
const DEPLOY_TAG = 'deploy-7f3a';
const cache = {
  match: vi.fn(async (_key: Request): Promise<Response | undefined> => undefined),
  put: vi.fn(async (_key: Request, _res: Response) => {}),
};
const overLimit = { limit: vi.fn(async () => ({ success: false })) };

let workerFetch: WorkerFetch;
beforeAll(async () => {
  // Both are read when app.ts loads: the edge cache, and the tag Vite's `define` injects into a build.
  vi.stubGlobal('caches', { default: cache });
  vi.stubGlobal('__SIGMA_DEPLOY_TAG__', DEPLOY_TAG);
  workerFetch = (await import('./app')).default.fetch as unknown as WorkerFetch;
});
beforeEach(() => {
  vi.stubEnv('DEV', false);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

async function run(url: string, env: object = {}) {
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void waits.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const res = await workerFetch(
    new Request(url, { headers: { 'CF-Connecting-IP': '203.0.113.60' } }),
    env as Env,
    ctx,
  );
  await Promise.all(waits);
  return res;
}

describe('app.ts — around the router', () => {
  it('hands React Router the server build lazily, for the build’s mode', async () => {
    expect(rr.mode).toBe(import.meta.env.MODE);
    await expect(rr.loadBuild!()).resolves.toMatchObject({ routes: { root: { id: 'root' } } });
  });

  it('keys the edge cache under the build’s deploy tag', async () => {
    await run('https://sigma.test/contracts?sort=total');
    const key = new URL(cache.match.mock.calls[0]![0].url);
    expect(key.pathname).toBe('/contracts');
    expect(key.searchParams.get('_dt')).toBe(DEPLOY_TAG);
    expect(key.searchParams.get('sort')).toBe('total');
  });

  it('sends cleartext HTTP to HTTPS in production before any other gate runs', async () => {
    vi.stubEnv('PROD', true);
    const res = await run('http://sigma.test/persons/abc?company=111111111');
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('https://sigma.test/persons/abc?company=111111111');
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
    expect(cache.match).not.toHaveBeenCalled();
    expect(rr.handler).not.toHaveBeenCalled();
  });

  it('throttles a person page after the cache miss and before its loader runs', async () => {
    const res = await run(`https://sigma.test/persons/${'a'.repeat(64)}.data`, {
      CONFLICTS_RATE_LIMITER: overLimit,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(overLimit.limit).toHaveBeenCalledWith({ key: '203.0.113.60' });
    expect(cache.match).toHaveBeenCalledTimes(1);
    expect(rr.handler).not.toHaveBeenCalled();
  });

  it('caches a response without a Content-Type as it is, without treating it as HTML', async () => {
    vi.stubEnv('PROD', true);
    const csp = "default-src 'self'; script-src 'self' 'nonce-abc123'";
    rr.handler.mockResolvedValueOnce(
      new Response(new Uint8Array([60, 112, 62]), {
        headers: { 'Cache-Control': 'public, s-maxage=60', 'Content-Security-Policy': csp },
      }),
    );
    const res = await run('https://sigma.test/impressum');
    expect(res.headers.get('X-Edge-Cache')).toBe('MISS');
    expect(res.headers.get('Content-Type')).toBeNull();
    // An HTML response would have its nonce swapped for script hashes; this one keeps the policy it came with.
    expect(res.headers.get('Content-Security-Policy')).toBe(csp);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([60, 112, 62]));
    expect(cache.put).toHaveBeenCalledTimes(1);
  });
});
