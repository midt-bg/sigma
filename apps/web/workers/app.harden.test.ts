import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercises the response-hardening path in app.ts that app.cache.test.ts doesn't reach: the
// nonce → hash CSP swap for an edge-cacheable HTML response (hardenResponse's `nonce !== null`
// branch), the OPTIONS short-circuit, and a cacheable response with no Content-Type header.

const NONCE = 'abc123nonce';
// A cacheable, anonymous HTML response carrying a per-request nonce CSP and one nonce-bearing
// framework script — the exact shape entry.server.tsx emits and hardenResponse must re-hash.
const HTML_WITH_NONCE = `<!doctype html><script nonce="${NONCE}">window.__d=1;</script><p>hi</p>`;

vi.mock('react-router', () => ({
  createRequestHandler: () => async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === '/no-content-type') {
      // Cacheable (s-maxage) but no Content-Type → isHtml's `?? ''` fallback, nonce stays null.
      return new Response('raw', {
        status: 200,
        headers: { 'Cache-Control': 'public, s-maxage=60' },
      });
    }
    return new Response(HTML_WITH_NONCE, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, s-maxage=1800',
        'Content-Security-Policy': `default-src 'self'; script-src 'self' 'nonce-${NONCE}'`,
      },
    });
  },
}));
vi.mock('virtual:react-router/server-build', () => ({}));
vi.mock('./request-log', () => ({
  withRequestLog: (
    request: Request,
    env: unknown,
    ctx: unknown,
    handler: (r: Request, e: unknown, c: unknown) => Promise<Response>,
  ) => handler(request, env, ctx),
}));
vi.mock('./aggregation-rate-limit', () => ({ rateLimitAggregationRoute: async () => null }));
vi.mock('./assistant-rate-limit', () => ({ rateLimitAssistantRoute: async () => null }));
vi.mock('./csv-rate-limit', () => ({ rateLimitCsvExport: async () => null }));
vi.mock('./search-rate-limit', () => ({ rateLimitSearchRoute: async () => null }));

const store = new Map<string, Response>();
const fakeCache = {
  async match(req: Request) {
    const hit = store.get(req.url);
    return hit ? hit.clone() : undefined;
  },
  async put(req: Request, res: Response) {
    store.set(req.url, res);
  },
};

let worker: { fetch: (r: Request, env: unknown, ctx: unknown) => Promise<Response> };

beforeAll(async () => {
  vi.stubGlobal('caches', { default: fakeCache });
  worker = ((await import('./app')) as { default: typeof worker }).default;
});

beforeEach(() => store.clear());

function run(url: string, init?: RequestInit) {
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void waits.push(p),
    passThroughOnException: () => {},
  };
  return worker.fetch(new Request(url, init), {}, ctx).then(async (res) => {
    const body = await res.clone().text();
    await Promise.all(waits);
    return { res, body };
  });
}

describe('app.ts response hardening', () => {
  it('swaps the per-request nonce CSP for a hash-based one on a cacheable HTML response (prod)', async () => {
    // Force prod so hardenResponse's `nonce !== null` branch actually rewrites the CSP: the SSR nonce
    // must be gone and the trusted framework script re-authorized by its sha256 hash instead. (Under
    // the default dev env nonceLessSecurityHeaders emits no CSP, so the swap would be unobservable and
    // the test would pass even if the branch were skipped — hence the stub.)
    vi.stubEnv('PROD', true);
    try {
      const { res, body } = await run('https://x/');
      expect(res.headers.get('X-Edge-Cache')).toBe('MISS');
      expect(body).toContain('window.__d=1;'); // body preserved through the buffered re-read
      const csp = res.headers.get('Content-Security-Policy') ?? '';
      expect(csp).not.toContain(`nonce-${NONCE}`); // the replayable nonce is gone
      expect(csp).toContain("'sha256-"); // replaced by the framework script's hash
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('short-circuits an OPTIONS preflight before the loader', async () => {
    const { res } = await run('https://x/anything', { method: 'OPTIONS' });
    expect(res.headers.get('Allow')).toContain('GET');
  });

  it('handles a cacheable response with no Content-Type (isHtml fallback) without hardening', async () => {
    const { res, body } = await run('https://x/no-content-type');
    expect(body).toBe('raw');
    expect(res.headers.get('X-Edge-Cache')).toBe('MISS');
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
  });
});
