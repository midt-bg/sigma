import { getDb } from '@sigma/db';
import { fakeD1, throwingD1 } from '@sigma/test-support';
import {
  UNSAFE_withComponentProps,
  UNSAFE_withErrorBoundaryProps,
  type ServerBuild,
} from 'react-router';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The site chrome's own read must not take a page down. The REAL worker (app.ts) drives the REAL
// React Router request handler over a build assembled from the REAL root module and a loader-less
// legal page, beside a fixture route that reads D1 itself — so the root loader, the error boundary,
// the route headers and the edge cache all take part as in production. Only D1 and the Cache API are
// doubles.

const build = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('virtual:react-router/server-build', () => build.current as object);
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
vi.mock('./assistant-rate-limit', () => ({ rateLimitAssistantRoute: async () => null }));

// D1's own words when its queue is full (see packages/db, retrying-d1.ts).
const OVERLOADED = 'D1_ERROR: D1 DB is overloaded. Requests queued for too long.';
const FOOTER_SQL = 'FROM home_totals';
const FIXTURE_SQL = 'SELECT label FROM synthetic_fixture';

type Store = Map<string, { body: string; headers: [string, string][]; expires: number }>;
const store: Store = new Map();
const edgeCache = {
  async match(request: Request | string) {
    const entry = store.get(typeof request === 'string' ? request : request.url);
    if (!entry || Date.now() >= entry.expires) return undefined;
    return new Response(entry.body, { headers: new Headers(entry.headers) });
  },
  async put(request: Request | string, response: Response) {
    const ttl = Number(/s-maxage=(\d+)/.exec(response.headers.get('Cache-Control') ?? '')?.[1]);
    store.set(typeof request === 'string' ? request : request.url, {
      body: await response.text(),
      headers: [...response.headers] as [string, string][],
      expires: Date.now() + ttl * 1000,
    });
  },
  async delete(request: Request | string) {
    return store.delete(typeof request === 'string' ? request : request.url);
  },
};

const routeAsset = {
  module: '',
  hasAction: false,
  hasClientAction: false,
  hasClientLoader: false,
  hasClientMiddleware: false,
  clientActionModule: undefined,
  clientLoaderModule: undefined,
  clientMiddlewareModule: undefined,
  hydrateFallbackModule: undefined,
};

async function assemble(): Promise<Partial<ServerBuild>> {
  const [entry, root, accessibility, cache] = await Promise.all([
    import('../app/entry.server'),
    import('../app/root'),
    import('../app/routes/accessibility'),
    import('../app/lib/cache'),
  ]);
  type Module = NonNullable<ServerBuild['routes'][string]>['module'];
  type Component = Parameters<typeof UNSAFE_withComponentProps>[0];
  const fixture = {
    headers: cache.cached(1800),
    loader: async ({ context }: { context: { cloudflare: { env: { DB: D1Database } } } }) =>
      getDb(context.cloudflare.env).prepare(FIXTURE_SQL).first<{ label: string }>(),
    default: UNSAFE_withComponentProps(
      (({ loaderData }: { loaderData: { label: string } }) =>
        loaderData.label) as unknown as Component,
    ),
  };
  return {
    entry: { module: entry },
    routes: {
      root: {
        id: 'root',
        path: '',
        module: {
          ...root,
          default: UNSAFE_withComponentProps(root.default as unknown as Component),
          ErrorBoundary: UNSAFE_withErrorBoundaryProps(
            root.ErrorBoundary as unknown as Parameters<typeof UNSAFE_withErrorBoundaryProps>[0],
          ),
        } as unknown as Module,
      },
      accessibility: {
        id: 'accessibility',
        parentId: 'root',
        path: 'accessibility',
        module: {
          ...accessibility,
          default: UNSAFE_withComponentProps(accessibility.default as unknown as Component),
        } as unknown as Module,
      },
      fixture: {
        id: 'fixture',
        parentId: 'root',
        path: 'fixture',
        module: fixture as unknown as Module,
      },
    },
    assets: {
      entry: { imports: [], module: '' },
      routes: {
        root: { ...routeAsset, id: 'root', path: '', hasLoader: true, hasErrorBoundary: true },
        accessibility: {
          ...routeAsset,
          id: 'accessibility',
          parentId: 'root',
          path: 'accessibility',
          hasLoader: false,
          hasErrorBoundary: false,
        },
        fixture: {
          ...routeAsset,
          id: 'fixture',
          parentId: 'root',
          path: 'fixture',
          hasLoader: true,
          hasErrorBoundary: false,
        },
      },
      url: '',
      version: 'fixture',
    },
    basename: '/',
    publicPath: '/',
    assetsBuildDirectory: '',
    unstable_getCriticalCss: undefined,
    allowedActionOrigins: undefined,
    future: {
      v8_middleware: false,
      v8_passThroughRequests: false,
      v8_trailingSlashAwareDataRequests: false,
    },
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: 'initial', manifestPath: '/__manifest' },
  } as Partial<ServerBuild>;
}

type WorkerFetch = (request: Request, env: unknown, ctx: unknown) => Promise<Response>;
let workerFetch: WorkerFetch;

beforeAll(async () => {
  vi.stubGlobal('caches', { default: edgeCache });
  vi.stubEnv('DEV', false);
  build.current = await assemble();
  workerFetch = (await import('./app')).default.fetch as unknown as WorkerFetch;
});

beforeEach(() => {
  store.clear();
  vi.stubEnv('DEV', false);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** A D1 whose footer read fails with `footer` (or answers), and whose fixture read answers. */
function database(footer: 'overloaded' | 'answers' | Error) {
  return fakeD1([
    {
      when: FOOTER_SQL,
      first: () => {
        if (footer === 'overloaded') throw new Error(OVERLOADED);
        if (footer instanceof Error) throw footer;
        return { as_of: '2000-03-04', refreshed_at: '2000-03-05 06:07:08' };
      },
    },
    {
      // The per-year coverage the data pages read beside it; an overloaded D1 refuses it too.
      when: 'FROM facet_counts',
      all: () => {
        if (footer === 'overloaded') throw new Error(OVERLOADED);
        return [];
      },
    },
    { when: FIXTURE_SQL, first: { label: 'Синтетичен ред' } },
  ]);
}

async function get(path: string, DB: D1Database) {
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
  const response = await workerFetch(
    new Request(`https://example.invalid${path}`, { headers: { 'User-Agent': 'Googlebot' } }),
    { DB },
    ctx,
  );
  const body = await response.text();
  await Promise.all(waits);
  return { status: response.status, headers: response.headers, body };
}

const storedPolicy = (path: string) =>
  new Headers([...store.entries()].find(([key]) => key.includes(path))?.[1].headers).get(
    'Cache-Control',
  );

describe('a page whose footer read D1 refuses', () => {
  it('still renders a loader-less page, with the footer figures marked unavailable', async () => {
    const { db } = database('overloaded');
    const page = await get('/accessibility', db);

    expect(page.status).toBe(200);
    expect(page.body).toContain('Декларация за достъпност');
    expect(page.body).toContain('обхватът и датите на данните временно не са налични');
    expect(page.body).not.toContain('данни обновени');
    expect(page.headers.get('X-Sigma-Degraded')).toBe('footer');
    expect(page.headers.get('Retry-After')).toBeNull();
  });

  it('keeps the degraded copy at the edge only briefly, never for the route lifetime', async () => {
    const { db } = database('overloaded');
    const page = await get('/accessibility', db);

    expect(page.headers.get('X-Edge-Cache')).toBe('MISS');
    // The visitor's browser revalidates every navigation, as for any HTML page.
    expect(page.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(storedPolicy('/accessibility')).toBe('public, s-maxage=30');

    // Within those seconds the copy shields D1; once they pass, the next visitor gets a full page.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 10_000);
      const shielded = await get('/accessibility', database('answers').db);
      expect(shielded.headers.get('X-Edge-Cache')).toBe('HIT');
      expect(shielded.headers.get('X-Sigma-Degraded')).toBe('footer');

      vi.setSystemTime(Date.now() + 25_000);
      const recovered = await get('/accessibility', database('answers').db);
      expect(recovered.headers.get('X-Edge-Cache')).toBe('MISS');
      expect(recovered.headers.get('X-Sigma-Degraded')).toBeNull();
      expect(recovered.body).toContain('данни обновени 05.03.2000');
      expect(storedPolicy('/accessibility')).toBe('public, s-maxage=3600');
    } finally {
      vi.useRealTimers();
    }
  });

  it('degrades the single-fetch data twin the same way', async () => {
    const { db } = database('overloaded');
    const data = await get('/fixture.data', db);

    expect(data.status).toBe(200);
    expect(data.body).toContain('Синтетичен ред');
    expect(data.headers.get('X-Sigma-Degraded')).toBe('footer');
    expect(storedPolicy('/fixture.data')).toBe('public, s-maxage=30');
  });

  it('serves a route whose own read succeeds, with its own data intact', async () => {
    const { db } = database('overloaded');
    const page = await get('/fixture', db);

    expect(page.status).toBe(200);
    expect(page.body).toContain('Синтетичен ред');
    expect(page.body).toContain('обхватът и датите на данните временно не са налични');
  });

  it('still fails a route whose own read D1 refuses', async () => {
    const { db } = fakeD1([
      {
        when: [],
        first: () => {
          throw new Error(OVERLOADED);
        },
      },
    ]);
    const page = await get('/fixture', db);

    expect(page.status).toBe(503);
    expect(page.headers.get('Cache-Control')).toBe('no-store');
    expect(page.headers.get('Retry-After')).toBe('30');
    expect(store.size).toBe(0);
  });

  it('still surfaces a footer read that fails for any other reason', async () => {
    const { db } = throwingD1(new Error('D1_ERROR: no such table: home_totals'));
    const page = await get('/accessibility', db);

    expect(page.status).toBe(500);
    expect(page.headers.get('Cache-Control')).toBe('no-store');
    expect(page.headers.get('X-Sigma-Degraded')).toBeNull();
    expect(store.size).toBe(0);
  });

  it('caches a page whose footer read succeeds for the full route lifetime', async () => {
    const { db, sql } = database('answers');
    const page = await get('/accessibility', db);
    expect(page.status).toBe(200);
    expect(page.body).toContain('последен договор 04.03.2000');
    expect(page.headers.get('X-Sigma-Degraded')).toBeNull();
    expect(storedPolicy('/accessibility')).toBe('public, s-maxage=3600');
    // The footer needs one row, not the per-year coverage scan the data pages read.
    expect(sql).toEqual([expect.stringContaining(FOOTER_SQL)]);
  });

  it('the worker redirects a non-canonical page path before anything is read', async () => {
    const { db, sql } = database('overloaded');
    const page = await get('/accessibility/', db);

    expect(page.status).toBe(301);
    expect(page.headers.get('Location')).toBe('/accessibility');
    expect(sql).toEqual([]);
  });

  it('the root loader still redirects a non-canonical data request before its footer read', async () => {
    // The worker leaves `.data` paths to the router, so this one reaches the root loader: its redirect is
    // thrown before the footer read, which an overloaded D1 therefore never sees and cannot degrade.
    const { db, sql } = database('overloaded');
    const page = await get('/Accessibility.data', db);

    expect(page.status).toBeLessThan(400);
    expect(page.body).toContain('/accessibility');
    expect(page.headers.get('X-Sigma-Degraded')).toBeNull();
    expect(sql).toEqual([]);
    expect(store.size).toBe(0);
  });
});
