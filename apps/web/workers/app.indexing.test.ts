import { fakeD1 } from '@sigma/test-support';
import type { ServerBuild } from 'react-router';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { getContract, csvLoader } = vi.hoisted(() => ({
  getContract: vi.fn(async (_db: D1Database, id: string) => ({
    id,
    bidder: { displayName: 'ТЕСТ', legalForm: id === 'c:sole-trader' ? 'ET' : 'EOOD' },
  })),
  csvLoader: vi.fn(),
}));

vi.mock('@sigma/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sigma/db')>()),
  getContract,
  getCompany: async (_db: D1Database, id: string) => ({
    displayName: 'ТЕСТ',
    legalForm: id === 'eik:000000002' ? 'ET' : 'EOOD',
    contracts: 1,
  }),
  getCompanyTies: async () => ({ center: null, nodes: [], edges: [] }),
  getCompanyPeople: async () => ({ roles: [] }),
  getPartialStartYear: async () => null,
  getSpendingTrend: async () => ({ points: [] }),
}));

// Run the real server handler against the actual route paths and loaders. Only the final document
// renderer is replaced so HTML header propagation can be tested without SSR assets.
vi.mock('virtual:react-router/server-build', async () => {
  const { default: routeConfig } = await import('../app/routes');
  const csvRoute = await import('../app/routes/companies.csv');
  csvLoader.mockImplementation(csvRoute.loader);
  const modules = {
    'routes/companies.csv.tsx': { ...csvRoute, loader: csvLoader },
    'routes/company.tsx': await import('../app/routes/company'),
    'routes/contract.json.tsx': await import('../app/routes/contract.json'),
    'routes/contract.tsx': await import('../app/routes/contract'),
  };
  const routes: ServerBuild['routes'] = {
    root: { id: 'root', path: '', module: { default: () => null } },
  };
  for (const [file, routeModule] of Object.entries(modules)) {
    const { path } = routeConfig.find((route) => route.file === file)!;
    routes[file] = {
      id: file,
      parentId: 'root',
      path,
      module: routeModule as unknown as NonNullable<ServerBuild['routes'][string]>['module'],
    };
  }
  return {
    entry: {
      module: {
        default(_request, status, headers) {
          headers.set('Content-Type', 'text/html; charset=utf-8');
          return new Response('<html>Fixture</html>', { status, headers });
        },
      },
    },
    routes,
    assets: { entry: { imports: [], module: '' }, routes: {}, url: '', version: 'fixture' },
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
  } satisfies ServerBuild;
});

const production = 'https://sigma.midt.bg';
const entries = new Map<string, Response>();
const cache = {
  match: vi.fn(async (key: Request) => entries.get(key.url)?.clone()),
  put: vi.fn(async (key: Request, response: Response) => entries.set(key.url, response.clone())),
  delete: vi.fn(async (key: Request) => entries.delete(key.url)),
};
const pending: Promise<unknown>[] = [];
const ctx = {
  waitUntil(promise: Promise<unknown>) {
    pending.push(promise);
  },
} as unknown as ExecutionContext;
const limit = vi.fn(async () => ({ success: true }));
const limiter = { limit } as RateLimit;
const { db: DB } = fakeD1([
  { when: 'FROM home_totals', first: { as_of: null, refreshed_at: null } },
  { when: 'ORDER BY bidder_id LIMIT ?', all: [] },
]);
const csv = 'eik,name\n';
const etag = '"fixture"';
const r2Get = vi.fn(async (_key: string, { onlyIf }: { onlyIf: Headers }) =>
  onlyIf.get('If-None-Match') === etag
    ? { httpEtag: etag }
    : { body: new Response(csv).body, size: csv.length, httpEtag: etag },
);
const env = {
  DB,
  CSV_CACHE: { get: r2Get } as unknown as R2Bucket,
  CSV_RATE_LIMITER: limiter,
  AGG_RATE_LIMITER: limiter,
} as Env;

let fetchWorker: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

beforeAll(async () => {
  vi.stubEnv('DEV', false);
  vi.stubEnv('PROD', true);
  vi.stubGlobal('caches', { default: cache });
  // Load the test build with its real route modules before the first request's assertions.
  await import('virtual:react-router/server-build');
  fetchWorker = (await import('./app')).default.fetch as unknown as typeof fetchWorker;
}, 15_000);

beforeEach(() => {
  entries.clear();
  vi.clearAllMocks();
});

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetchWorker(new Request(`${production}${path}`, init), env, ctx);
  await Promise.all(pending.splice(0));
  return response;
}

function get(path: string, headers?: HeadersInit): Promise<Response> {
  return request(path, { headers });
}

describe('indexing on the production host', () => {
  it.each(['.json', '.JSON', '%2Ejson', '.%6Ason'])(
    'marks a real JSON resource ending in %s',
    async (suffix) => {
      const response = await get(`/contracts/TeST%2Fitem%3Fnote${suffix}?ref=fixture`);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
      expect(await response.json()).toMatchObject({ id: 'c:TeST/item?note' });
    },
  );

  it('retains noindex from an encoded JSON MISS to the canonical HIT', async () => {
    const miss = await get('/contracts/fixture%2Ejson?ref=fixture');
    const hit = await get('/contracts/fixture.json');
    expect(miss.headers.get('X-Edge-Cache')).toBe('MISS');
    expect(hit.headers.get('X-Edge-Cache')).toBe('HIT');
    expect(hit.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(await hit.json()).toEqual(await miss.json());
  });

  it.each(['/companies.csv', '/COMPANIES.CSV', '/companies%2Ecsv'])(
    'marks CSV at %s',
    async (path) => {
      let response = await get(`${path}?sector=45`);
      if (path === '/COMPANIES.CSV') {
        expect(response.status).toBe(301);
        expect(response.headers.get('Location')).toBe('/companies.csv?sector=45');
        response = await get('/companies.csv?sector=45');
      }
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
      expect(response.headers.get('X-Csv-Cache')).toBe('dynamic');
      expect(await response.text()).toContain('eik,name,');
      expect(r2Get).not.toHaveBeenCalled();
    },
  );

  it.each(['/companies.csv.data', '/companies%2Ecsv.data'])(
    'refuses %s before the cache, limiter or CSV loader',
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not Found');
      expect(cache.match).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();
      expect(cache.delete).not.toHaveBeenCalled();
      expect(limit).not.toHaveBeenCalled();
      expect(csvLoader).not.toHaveBeenCalled();
      expect(r2Get).not.toHaveBeenCalled();
    },
  );

  it('answers HEAD on the CSV single-fetch twin without opening the export', async () => {
    const response = await request('/companies%2Ecsv.data', { method: 'HEAD' });
    expect(response.status).toBe(404);
    expect(response.body).toBeNull();
    expect(cache.match).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
    expect(csvLoader).not.toHaveBeenCalled();
    expect(r2Get).not.toHaveBeenCalled();
  });

  it('marks 200 and 304 responses from R2 on the encoded CSV resource', async () => {
    const full = await get('/companies%2Ecsv');
    expect(full.status).toBe(200);
    expect(full.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(await full.text()).toBe(csv);
    const conditional = await get('/companies%2Ecsv', { 'If-None-Match': etag });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(conditional.headers.get('ETag')).toBe(etag);
    expect(r2Get).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['/contracts/fixture', null],
    ['/contracts/sole-trader', 'noindex'],
    ['/companies/000000001', null],
    ['/companies/000000002', 'noindex'],
  ])('applies the HTML indexing policy to %s', async (path, directive) => {
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toMatch(/^text\/html/);
    expect(response.headers.get('X-Robots-Tag')).toBe(directive);
  });

  it.each([
    ['/contracts/fixture', null],
    ['/contracts/fixture.data', 'noindex'],
  ])(
    'returns an uncached retry response when %s disconnects before rendering',
    async (path, directive) => {
      const response = await request(path, { signal: AbortSignal.abort() });
      expect(response.status).toBe(503);
      expect(response.headers.get('X-Edge-Cache')).toBe('BYPASS');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Retry-After')).toBe('30');
      expect(response.headers.get('X-Robots-Tag')).toBe(directive);
      expect(getContract).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['%2Edata', 'data'],
    ['.%64ata', 'data'],
    ['.DATA', 'DATA'],
  ])('keeps the literal .data transport separate from the %s document', async (suffix, decoded) => {
    const transportPath = '/contracts/fixture.data';
    const documentPath = `/contracts/fixture${suffix}`;
    const transport = await get(transportPath);
    const document = await get(documentPath);
    expect(transport.status).toBe(200);
    expect(document.status).toBe(200);
    expect(transport.headers.get('Content-Type')).toMatch(/^text\/x-script/);
    expect(document.headers.get('Content-Type')).toMatch(/^text\/html/);
    expect(transport.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(document.headers.get('X-Robots-Tag')).toBeNull();
    expect(transport.headers.get('X-Edge-Cache')).toBe('MISS');
    expect(document.headers.get('X-Edge-Cache')).toBe('MISS');
    const payload = await transport.text();
    expect(payload).toContain('"c:fixture"');
    expect(await document.text()).toBe('<html>Fixture</html>');
    expect(getContract.mock.calls.map(([, id]) => id)).toEqual([
      'c:fixture',
      `c:fixture.${decoded}`,
    ]);
    expect([...entries.keys()].map((key) => new URL(key).pathname)).toEqual([
      transportPath,
      documentPath,
    ]);

    const cachedTransport = await get(transportPath);
    const cachedDocument = await get(documentPath);
    expect(cachedTransport.headers.get('X-Edge-Cache')).toBe('HIT');
    expect(cachedDocument.headers.get('X-Edge-Cache')).toBe('HIT');
    expect(cachedTransport.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(cachedDocument.headers.get('X-Robots-Tag')).toBeNull();
    expect(await cachedTransport.text()).toBe(payload);
    expect(await cachedDocument.text()).toBe('<html>Fixture</html>');
    expect(getContract).toHaveBeenCalledTimes(2);
  });

  it.each(['/Companies', '/companies/', '/C%6Fmpanies'])(
    'redirects the HTML list alias %s',
    async (path) => {
      const response = await get(`${path}?sector=45&year=2024`);
      expect(response.status).toBe(301);
      expect(response.headers.get('Location')).toBe('/companies?sector=45&year=2024');
    },
  );

  it('preserves detail slug delimiters and the query when normalizing a route name', async () => {
    const response = await get('/C%6Fntracts/TeST%2Fitem%3Fnote?ref=a%2Fb');
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('/contracts/TeST%2Fitem%3Fnote?ref=a%2Fb');
  });
});
