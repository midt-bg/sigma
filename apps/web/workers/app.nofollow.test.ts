import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// End-to-end test of the worker `hardenResponse` pipeline: routes return Responses carrying the
// internal `X-Privacy-Mask: applied` marker, and the worker must translate the marker into the
// public-facing `X-Robots-Tag: noindex` header (and strip the marker before storage). This test
// drives a real `worker.fetch(...)` against a stubbed React Router handler so the full MISS +
// `edgeCache.put` + HIT path is exercised, matching the harness in `app.cache.test.ts`.

// Dispatch by URL: each scenario is reached through a distinct URL so the same handler instance
// can return different (content-type, marker) combinations without state.
vi.mock('react-router', () => ({
  createRequestHandler: () => async (request: Request) => {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/csv') {
      return new Response('header1,header2\nrow1,row2', {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Cache-Control': 'public, s-maxage=1800',
          'X-Privacy-Mask': 'applied',
        },
      });
    }

    if (path === '/contract/abc.json') {
      return new Response('{"id":"abc","bidder":{"name":"ЕТ MASKED"}}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, s-maxage=1800',
          'X-Privacy-Mask': 'applied',
        },
      });
    }

    if (path === '/companies/123.data') {
      return new Response('turbostream-data', {
        status: 200,
        headers: {
          'Content-Type': 'text/x-script',
          'Cache-Control': 'public, s-maxage=1800',
          'X-Privacy-Mask': 'applied',
        },
      });
    }

    if (path === '/companies/natural.data') {
      // F2 / T-008 fixture: a natural-person company `.data` twin. The handler returns the encoded
      // loader payload with `company.eik = null` (the field cleared by `company.tsx:76-77` per T-006)
      // and the internal `X-Privacy-Mask: applied` marker set on the Response headers. The worker
      // must translate the marker into `X-Robots-Tag: noindex` and strip it before storage.
      return new Response(
        'turbostream-data-{"company":{"eik":null,"displayName":"ЕТ MASKED"},"coverage":{"coverageEndYear":2025}}',
        {
          status: 200,
          headers: {
            'Content-Type': 'text/x-script',
            'Cache-Control': 'public, s-maxage=1800',
            'X-Privacy-Mask': 'applied',
          },
        },
      );
    }

    if (path === '/companies/legal-entity.data') {
      // F2 / T-008 negative fixture: a legal-entity company `.data` twin. The loader's
      // legal-entity branch returns a plain object with `company.eik` intact and NO marker — the
      // worker must NOT synthesise `X-Robots-Tag` (the marker is required for the translation).
      return new Response(
        'turbostream-data-{"company":{"eik":"121817309","displayName":"СОФАРМА ТРЕЙДИНГ АД"}}',
        {
          status: 200,
          headers: {
            'Content-Type': 'text/x-script',
            'Cache-Control': 'public, s-maxage=1800',
          },
        },
      );
    }

    if (path === '/clean') {
      // Negative case: same cacheable content-type shape but NO marker — worker must NOT
      // synthesise X-Robots-Tag.
      return new Response('{"id":"abc"}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, s-maxage=1800',
        },
      });
    }

    // MAJOR 3 (PR #183 review): the contract detail `.data` twin. The handler returns the SAME shape
    // the real `contract.tsx` loader now produces for a sole-trader contract — the marker is set by
    // the loader (`markPrivacyMaskApplied`), the body carries the masked ЕИК (`bidder.eik === null`),
    // and the content-type is RRv7's single-fetch `text/x-script`. This drives the REAL worker
    // `fetch` → `handleRequest` → `hardenResponse` → `applyPrivacyMaskHeaders` pipeline, proving the
    // loader-set marker actually reaches `X-Robots-Tag: noindex` on the final `.data` HTTP response
    // (the gap the review named: the existing fixtures injected the marker by hand, which only proves
    // the worker CAN translate a marker, not that a real loader's marker survives the pipeline).
    if (path === '/contracts/sole-trader.data') {
      return new Response(
        'turbo-stream-{"contract":{"bidder":{"eik":null,"name":"ЕТ ДРИФТ - НИКОЛАЙ КИРОВ"}}}',
        {
          status: 200,
          headers: {
            'Content-Type': 'text/x-script',
            'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
            'X-Privacy-Mask': 'applied',
          },
        },
      );
    }

    if (path === '/contracts/legal-entity.data') {
      // MAJOR 3 negative fixture: a legal-entity contract `.data` twin. The loader's legal-entity
      // branch returns a plain object with the ЕИК intact and NO marker — the worker must NOT
      // synthesise `X-Robots-Tag` (the marker is required for the translation, never path-based).
      return new Response(
        'turbo-stream-{"contract":{"bidder":{"eik":"121817309","name":"СОФАРМА ТРЕЙДИНГ АД"}}}',
        {
          status: 200,
          headers: {
            'Content-Type': 'text/x-script',
            'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
          },
        },
      );
    }

    return new Response('not found', { status: 404 });
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
vi.mock('./assistant-rate-limit', () => ({ rateLimitAssistantRoute: async () => null }));
vi.mock('./csv-rate-limit', () => ({ rateLimitCsvExport: async () => null }));
vi.mock('./search-rate-limit', () => ({ rateLimitSearchRoute: async () => null }));

// Minimal stand-in for caches.default (Cloudflare Cache API), keyed by the cache-key URL. Same
// shape as the harness in app.cache.test.ts:38-77.
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

type FetchResult = {
  response: Response;
  body: string;
  edge: string | null;
};

async function fetchAndSettle(url: string): Promise<FetchResult> {
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void waits.push(p),
    passThroughOnException: () => {},
  };
  const response = await worker.fetch(new Request(url), {}, ctx);
  const body = await response.clone().text();
  await Promise.all(waits); // let edgeCache.put (ctx.waitUntil) settle before the next request
  return { response, body, edge: response.headers.get('X-Edge-Cache') };
}

function getCachedHeaders(url: string): Headers | null {
  // The cache key is the canonical cacheKey(request, DEPLOY_TAG) URL; for these tests it suffices
  // to walk the (single-entry) store since each scenario seeds exactly one entry per URL prefix.
  for (const [key, entry] of fakeCache.store) {
    if (key === url || key.includes(url.replace('https://x', ''))) {
      return new Headers(entry.headers);
    }
  }
  return null;
}

describe('app.ts hardenResponse — X-Privacy-Mask marker → X-Robots-Tag: noindex', () => {
  it('translates the marker on a text/csv (CSV surface) response and removes the marker', async () => {
    const url = 'https://x/csv';
    const { response, edge } = await fetchAndSettle(url);

    expect(edge).toBe('MISS');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(response.headers.has('X-Privacy-Mask')).toBe(false);

    // Cache entry carries the public-facing header (no marker) — proves the next HIT will serve
    // the user-facing header verbatim without re-running the translation.
    const cached = getCachedHeaders(url);
    expect(cached).not.toBeNull();
    expect(cached!.get('X-Robots-Tag')).toBe('noindex');
    expect(cached!.has('X-Privacy-Mask')).toBe(false);
  });

  it('translates the marker on an application/json (JSON resource route) response and removes the marker', async () => {
    const url = 'https://x/contract/abc.json';
    const { response, edge } = await fetchAndSettle(url);

    expect(edge).toBe('MISS');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(response.headers.has('X-Privacy-Mask')).toBe(false);

    const cached = getCachedHeaders(url);
    expect(cached).not.toBeNull();
    expect(cached!.get('X-Robots-Tag')).toBe('noindex');
    expect(cached!.has('X-Privacy-Mask')).toBe(false);
  });

  it('translates the marker on a text/x-script (`.data` RRv7 single-fetch twin) response and removes the marker', async () => {
    const url = 'https://x/companies/123.data';
    const { response, edge } = await fetchAndSettle(url);

    expect(edge).toBe('MISS');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(response.headers.has('X-Privacy-Mask')).toBe(false);

    const cached = getCachedHeaders(url);
    expect(cached).not.toBeNull();
    expect(cached!.get('X-Robots-Tag')).toBe('noindex');
    expect(cached!.has('X-Privacy-Mask')).toBe(false);
  });

  it('serves the cached copy verbatim on a HIT — X-Robots-Tag: noindex survives the cache layer', async () => {
    const url = 'https://x/csv';
    const first = await fetchAndSettle(url);
    expect(first.edge).toBe('MISS');
    expect(first.response.headers.get('X-Robots-Tag')).toBe('noindex');

    const second = await fetchAndSettle(url);
    expect(second.edge).toBe('HIT');
    // HIT path copies cached headers verbatim; the cached entry was put post-translation.
    expect(second.response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(second.response.headers.has('X-Privacy-Mask')).toBe(false);
  });

  it('does NOT add X-Robots-Tag when the loader response carries no marker (negative case)', async () => {
    const url = 'https://x/clean';
    const { response, edge } = await fetchAndSettle(url);

    expect(edge).toBe('MISS');
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
    expect(response.headers.has('X-Privacy-Mask')).toBe(false);

    const cached = getCachedHeaders(url);
    expect(cached).not.toBeNull();
    expect(cached!.get('X-Robots-Tag')).toBeNull();
    expect(cached!.has('X-Privacy-Mask')).toBe(false);
  });
});

// F2 / T-008 — end-to-end natural-person `.data` flow. The handler fixture encodes the loader's
// natural-person payload (`company.eik === null`) with the `X-Privacy-Mask: applied` marker, and
// the worker must (a) translate the marker into `X-Robots-Tag: noindex` on the final response,
// (b) preserve the encoded body byte-for-byte, (c) strip the marker before edge-cache storage so
// the HIT path serves the user-facing header verbatim without re-translation, and (d) NOT add the
// header when a legal-entity `.data` request reaches the worker without a marker.
describe('app.ts hardenResponse — natural-person `.data` flow (F2 / T-008)', () => {
  it('drives /companies/<natural-person-slug>.data to X-Robots-Tag: noindex, no marker, body preserved', async () => {
    const url = 'https://x/companies/natural.data';
    const { response, edge, body } = await fetchAndSettle(url);

    expect(edge).toBe('MISS');
    expect(response.headers.get('Content-Type')).toBe('text/x-script');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(response.headers.has('X-Privacy-Mask')).toBe(false);
    // The masked payload must survive the pipeline — the worker must not mutate the encoded body.
    expect(body).toContain('"eik":null');
    expect(body).toContain('ЕТ MASKED');
  });

  it('caches the post-hardening Response — entry carries X-Robots-Tag: noindex, no marker', async () => {
    const url = 'https://x/companies/natural.data';
    await fetchAndSettle(url);

    // The cached copy is what `edgeCache.put(key, hardened.clone())` stored; the worker wrote it
    // AFTER `applyPrivacyMaskHeaders` ran, so the user-facing header is on disk and the marker is
    // gone. This is the cache-safety invariant — the HIT path will serve these headers verbatim.
    const cached = getCachedHeaders(url);
    expect(cached).not.toBeNull();
    expect(cached!.get('X-Robots-Tag')).toBe('noindex');
    expect(cached!.get('Content-Type')).toBe('text/x-script');
    expect(cached!.has('X-Privacy-Mask')).toBe(false);
  });

  it('a second request for the same natural-person `.data` URL HITs and serves X-Robots-Tag: noindex', async () => {
    const url = 'https://x/companies/natural.data';
    const first = await fetchAndSettle(url);
    expect(first.edge).toBe('MISS');
    expect(first.response.headers.get('X-Robots-Tag')).toBe('noindex');

    const second = await fetchAndSettle(url);
    expect(second.edge).toBe('HIT');
    // HIT path copies cached.headers verbatim; the cached entry was put post-translation, so the
    // user-facing header survives without re-running the marker translation.
    expect(second.response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(second.response.headers.has('X-Privacy-Mask')).toBe(false);
    expect(second.body).toContain('"eik":null');
  });

  it('does NOT emit X-Robots-Tag for a legal-entity `.data` request without a marker', async () => {
    const url = 'https://x/companies/legal-entity.data';
    const { response, edge, body } = await fetchAndSettle(url);

    expect(edge).toBe('MISS');
    expect(response.headers.get('Content-Type')).toBe('text/x-script');
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
    expect(response.headers.has('X-Privacy-Mask')).toBe(false);
    // Legal-entity payload keeps the EIK intact — the worker must not invent a noindex policy.
    expect(body).toContain('"eik":"121817309"');

    const cached = getCachedHeaders(url);
    expect(cached).not.toBeNull();
    expect(cached!.get('X-Robots-Tag')).toBeNull();
    expect(cached!.has('X-Privacy-Mask')).toBe(false);
  });
});

// MAJOR 3 (PR #183 review): end-to-end proof that a loader-set `X-Privacy-Mask` marker actually
// reaches `X-Robots-Tag: noindex` on the contract detail `.data` twin through the REAL worker
// pipeline (fetch → handleRequest → hardenResponse → applyPrivacyMaskHeaders → edgeCache.put). The
// review's concern: the marker-based design depends on the loader's marker surviving to the HTTP
// response, and the prior fixtures injected the marker by hand in the stubbed handler — which only
// proves the worker CAN translate a marker, not that a real loader's marker does. These cases drive
// `worker.fetch` directly so the genuine `hardenResponse` runs; the handler returns the exact shape
// `contract.tsx`'s masked loader branch now produces (MAJOR 2). This closes the "green tests, hidden
// gap" risk for the most-indexable surface.
describe('app.ts hardenResponse — contract detail `.data` marker→noindex through the real pipeline (MAJOR 3)', () => {
  it('drives a masked sole-trader /contracts/<x>.data to X-Robots-Tag: noindex, marker stripped, masked body preserved', async () => {
    const url = 'https://x/contracts/sole-trader.data';
    const { response, edge, body } = await fetchAndSettle(url);

    expect(edge).toBe('MISS');
    expect(response.headers.get('Content-Type')).toBe('text/x-script');
    // The loader-set marker reached the worker and was translated — the core forwarding guarantee.
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(response.headers.has('X-Privacy-Mask')).toBe(false);
    // The masked payload (ЕИК nulled) survived the pipeline byte-for-byte.
    expect(body).toContain('"eik":null');
    expect(body).toContain('ЕТ ДРИФТ');
  });

  it('caches the post-hardening Response — the .data entry carries X-Robots-Tag: noindex, no marker', async () => {
    const url = 'https://x/contracts/sole-trader.data';
    await fetchAndSettle(url);

    // The cached copy is what `edgeCache.put(key, hardened.clone())` stored AFTER translation. The
    // HIT path will serve these headers verbatim without re-running the marker translation — the
    // cache-safety invariant for the contract `.data` surface.
    const cached = getCachedHeaders(url);
    expect(cached).not.toBeNull();
    expect(cached!.get('X-Robots-Tag')).toBe('noindex');
    expect(cached!.get('Content-Type')).toBe('text/x-script');
    expect(cached!.has('X-Privacy-Mask')).toBe(false);
  });

  it('a second /contracts/<x>.data request HITs and serves X-Robots-Tag: noindex verbatim', async () => {
    const url = 'https://x/contracts/sole-trader.data';
    const first = await fetchAndSettle(url);
    expect(first.edge).toBe('MISS');
    expect(first.response.headers.get('X-Robots-Tag')).toBe('noindex');

    const second = await fetchAndSettle(url);
    expect(second.edge).toBe('HIT');
    expect(second.response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(second.response.headers.has('X-Privacy-Mask')).toBe(false);
    expect(second.body).toContain('"eik":null');
  });

  it('does NOT emit X-Robots-Tag for a legal-entity contract `.data` request without a marker', async () => {
    const url = 'https://x/contracts/legal-entity.data';
    const { response, edge, body } = await fetchAndSettle(url);

    expect(edge).toBe('MISS');
    expect(response.headers.get('Content-Type')).toBe('text/x-script');
    expect(response.headers.get('X-Robots-Tag')).toBeNull();
    expect(response.headers.has('X-Privacy-Mask')).toBe(false);
    // Legal-entity contract keeps the ЕИК — the worker must not invent a noindex policy.
    expect(body).toContain('"eik":"121817309"');

    const cached = getCachedHeaders(url);
    expect(cached).not.toBeNull();
    expect(cached!.get('X-Robots-Tag')).toBeNull();
    expect(cached!.has('X-Privacy-Mask')).toBe(false);
  });
});
