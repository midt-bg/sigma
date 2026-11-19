import { createRequestHandler } from 'react-router';
import { isIndexedHost } from '../app/lib/indexing';
import { baseSecurityHeaders, nonceLessSecurityHeaders } from '../app/lib/security';
import { rateLimitAggregationRoute } from './aggregation-rate-limit';
import { rateLimitAssistantRoute } from './assistant-rate-limit';
import { normalizedPathname } from './rate-limit';
import { cacheKey, canonicalRequest, isRouteManifest } from './cache-key';
import { cspNonce, hashTrustedInlineScripts } from './csp';
import { dataGeneration } from './data-generation';
import { isFresh, stamped, unstamp } from './edge-entry';
import { rateLimitCsvExport } from './csv-rate-limit';
import {
  optionsResponse,
  redirectCleartextHttp,
  redirectToCanonicalPath,
  setAllowHeader,
} from './http';
import { rateLimitSearchRoute } from './search-rate-limit';
import { claim, inFlight } from './render-gate';
import { withRequestLog } from './request-log';

declare module 'react-router' {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import('virtual:react-router/server-build'),
  import.meta.env.MODE,
);

// `caches.default` is a Cloudflare extension to the DOM CacheStorage type; the DOM lib (loaded by
// React Router) types `caches` without it. Assert through unknown so the per-colo edge cache is
// typed correctly without changing runtime behaviour.
const edgeCache = (caches as unknown as { default: Cache }).default;

// Build-time-unique tag (injected by Vite `define`, see vite.config.ts), prefixed into the cache key so a
// fresh deploy rotates every key and orphans the previous deploy's cached entries — no manual purge; old
// entries TTL out, new requests populate under the new tag. The Cache API has no namespace concept, so we
// synthesise one by mutating the cache-key URL (the served response is unaffected). It MUST come from the
// build, NOT `Date.now()` here: Cloudflare pins the clock in a worker's global scope for deterministic
// startup snapshots, so a runtime Date.now() was constant across deploys and never invalidated the cache —
// stale HTML (and data) survived every redeploy. The typeof guard keeps the worker from crashing if the
// define is ever misconfigured (a bare reference to an unreplaced identifier would ReferenceError); it then
// degrades to the old constant-tag behaviour, never worse.
declare const __SIGMA_DEPLOY_TAG__: string | undefined;
const DEPLOY_TAG =
  typeof __SIGMA_DEPLOY_TAG__ !== 'undefined' ? __SIGMA_DEPLOY_TAG__ : Date.now().toString(36);

// The request headers the Cache API answers by itself: a validator with a 304, a range with a 206.
const CONDITIONAL = ['If-None-Match', 'If-Modified-Since', 'Range'];

// The stored GET for `key` in full, whatever the request asks of it, with the worker's notes
// (edge-entry.ts) still on it — or null. Whether it may be served is for the caller to decide.
async function storedCopy(key: Request): Promise<Response | null> {
  const plain = new Request(key);
  for (const name of CONDITIONAL) plain.headers.delete(name);
  return (await edgeCache.match(plain)) ?? null;
}

// A stored copy on its way out: the worker's notes off, security headers re-applied. `HIT` is a fresh
// copy; `STALE` is the last good one, standing in for a page that could not be rendered just now.
function served(copy: Response, edge: 'HIT' | 'STALE'): Response {
  const headers = new Headers(copy.headers);
  unstamp(headers);
  applySecurityHeaders(headers, baseSecurityHeaders(import.meta.env.PROD));
  headers.set('X-Edge-Cache', edge);
  return new Response(copy.body, { status: copy.status, statusText: copy.statusText, headers });
}

// A fresh copy for this request: what the Cache API makes of the request's own validators or range when
// it carries any, the copy itself otherwise.
async function freshResponse(key: Request, copy: Response): Promise<Response> {
  if (CONDITIONAL.some((name) => key.headers.has(name))) {
    const conditional = await cachedResponse(key);
    if (conditional) {
      await copy.body?.cancel();
      return conditional;
    }
  }
  return served(copy, 'HIT');
}

// The stored GET for `key` as the Cache API answers this very request, as a HIT (security headers
// re-applied), or null.
async function cachedResponse(key: Request): Promise<Response | null> {
  const cached = await edgeCache.match(key);
  if (!cached) return null;
  const headers = new Headers(cached.headers);
  unstamp(headers);
  if (cached.status === 304 && !headers.has('Content-Type')) {
    // Cache API evaluates the browser's validators but omits Content-Type from its 304. Recover the
    // representation's type so handleRequest applies the same browser policy as for a 200; otherwise
    // the internal s-maxage/SWR leaks back into the browser's stored HTML. Keep the bodyless 304 and
    // consult only the edge entry, without another render or database read.
    const lookup = new Request(key);
    lookup.headers.delete('If-None-Match');
    lookup.headers.delete('If-Modified-Since');
    lookup.headers.delete('Range');
    const representation = await edgeCache.match(lookup);
    // A 304 may have lost the worker's notes as well; the route's own policy is on the full copy.
    if (representation) unstamp(headers, representation.headers);
    const contentType = representation?.headers.get('Content-Type');
    if (contentType) headers.set('Content-Type', contentType);
    // The entry can expire between the two lookups. Do not extend a browser entry whose type we
    // cannot establish; the next request can retrieve its full representation.
    else headers.set('Cache-Control', 'no-store');
    await representation?.body?.cancel();
  }
  applySecurityHeaders(headers, baseSecurityHeaders(import.meta.env.PROD));
  headers.set('X-Edge-Cache', 'HIT');
  return new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers,
  });
}

function applySecurityHeaders(headers: Headers, security: Headers): void {
  for (const [key, value] of security) headers.set(key, value);
}

function isAnonymous(request: Request, response: Response): boolean {
  return (
    !request.headers.has('Authorization') &&
    !request.headers.has('Cookie') &&
    !response.headers.has('Set-Cookie')
  );
}

function isHtml(response: Response): boolean {
  return (response.headers.get('Content-Type') ?? '').toLowerCase().includes('text/html');
}

// Responses that name individuals → noindex them. This is the ONE place that covers both the HTML and its
// single-fetch `.data` twin: the twin is JSON with no <head>, so a route <meta robots> can't reach it, and a
// resource route's loader `data(..., {headers})` doesn't propagate to the .data HTTP response. normalizedPathname
// strips a trailing `.data` (and duplicate slashes), so a twin matches the same rule.
//   • /conflicts*        — the свързани-лица surface. /conflicts/methodology is the deliberately-indexed
//                          public credibility anchor (ADR-0020/0021), so it is excluded.
//   • /search, /search/* — search now surfaces свързани-лица officials by name (the министър's ask), incl. the
//                          /search/suggest typeahead which is a JSON resource route with no <head> at all. The
//                          page already sets <meta robots noindex>; this makes the header cover the JSON twins.
function isNoindexNamesPath(request: Request): boolean {
  const p = normalizedPathname(request);
  if (/\.(?:data|json|csv)$/.test(new URL(request.url).pathname)) return true;
  if (p === '/persons' || p.startsWith('/persons/')) return true;
  if (p === '/search' || p.startsWith('/search/')) return true;
  return (p === '/conflicts' || p.startsWith('/conflicts/')) && p !== '/conflicts/methodology';
}

// Apply the shared base headers, and for edge-cacheable HTML swap the per-request nonce CSP for a
// nonce-LESS, hash-based one so a frozen cache entry doesn't replay one nonce to every visitor for
// the whole s-maxage lifetime (the regression 88fd683 fixed). The hashes cover only the nonce-bearing
// framework scripts (hashTrustedInlineScripts), so the policy stays cache-safe WITHOUT
// self-authorizing an injected inline script. Non-cacheable / non-HTML responses keep the nonce CSP.
async function hardenResponse(response: Response, cacheable: boolean): Promise<Response> {
  const headers = new Headers(response.headers);
  applySecurityHeaders(headers, baseSecurityHeaders(import.meta.env.PROD));
  setAllowHeader(headers, response.status);

  const nonce = cacheable && isHtml(response) ? cspNonce(headers) : null;
  if (nonce !== null) {
    const body = await response.text();
    applySecurityHeaders(
      headers,
      nonceLessSecurityHeaders(await hashTrustedInlineScripts(body, nonce), import.meta.env.PROD),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    return withRequestLog(request, env, ctx, handleRequest);
  },
} satisfies ExportedHandler<Env>;

// A HEAD is answered as the GET it describes, headers only: from the GET's cache entry when there is one,
// and otherwise by rendering (and caching) that GET — never a separate, uncached run of the loaders.
async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const response = await respond(
    request.method === 'HEAD' ? new Request(request, { method: 'GET' }) : request,
    env,
    ctx,
  );
  // Apply after respond has cloned the edge entry, including on HIT and single-flight HIT. The
  // browser must consult this deployment on every navigation; s-maxage/SWR belong only to the
  // internal edge copy. Otherwise a browser can replay an old response after a deployment rotates
  // the edge keys. Fingerprinted assets and downloadable resources keep their own cache policy.
  const headers = new Headers(response.headers);
  if (response.status >= 500) {
    headers.set('Cache-Control', 'no-store');
    if (response.status === 503) headers.set('Retry-After', '30');
  } else if (
    (isHtml(response) || new URL(request.url).pathname.endsWith('.data')) &&
    !/\b(?:no-store|private)\b/i.test(headers.get('Cache-Control') ?? '')
  ) {
    headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  }
  return new Response(request.method === 'HEAD' ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function respond(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const httpsRedirect = redirectCleartextHttp(request, import.meta.env.PROD);
  if (httpsRedirect) return httpsRedirect;
  const canonicalRedirect = redirectToCanonicalPath(request, import.meta.env.PROD);
  if (canonicalRedirect) return canonicalRedirect;

  if (request.method === 'OPTIONS') return optionsResponse(import.meta.env.PROD);

  // The loader sees only the query its route reads (app/lib/query-params.ts), the same query the cache
  // key carries, so a junk or unknown value neither mints a new key nor renders into a shared one.
  const routeManifest = isRouteManifest(request);
  if (request.method === 'GET' && !routeManifest) request = canonicalRequest(request);

  const csvRateLimitResponse = await rateLimitCsvExport(request, env, import.meta.env.PROD);
  if (csvRateLimitResponse) return csvRateLimitResponse;

  // Per-colo edge cache (Cache API) for GET responses that opt in via Cache-Control: s-maxage=N
  // (publicCache() in apps/web/app/lib/cache.ts). Deterministic and independent of platform
  // HTML-cache heuristics on *.workers.dev; TTL is driven by s-maxage. The X-Edge-Cache:
  // HIT|MISS|BYPASS header lets `curl -I` verify which path a request took.
  // A persisted emulator cache must not mix an old loader payload with a hot-reloaded UI.
  // Production caching is unchanged; local development always reads its current database/code.
  // A `.data` request with `_routes` asks React Router for SOME of the route loaders only. The key does not
  // carry `_routes`, so storing that partial answer would serve it as the whole page's data to every later
  // navigation in the colo — and serving the whole answer to it would be wrong the other way. Neither is
  // looked up nor stored; the app's own navigations do not send `_routes`.
  const key =
    !import.meta.env.DEV &&
    request.method === 'GET' &&
    !routeManifest &&
    !new URL(request.url).searchParams.has('_routes')
      ? cacheKey(request, DEPLOY_TAG)
      : null;
  // A stored page is served as it is while it is fresh (edge-entry.ts). Past that it is rendered again —
  // and stays at hand as the last good copy, should that render be refused or fail.
  const began = Date.now();
  const generation = key ? dataGeneration(env, ctx, began) : null;
  let copy = key && (await storedCopy(key));
  if (key && copy && isFresh(copy.headers, began, generation)) return freshResponse(key, copy);

  const limited =
    (await rateLimitAggregationRoute(request, env, import.meta.env.PROD)) ??
    (await rateLimitSearchRoute(request, env, import.meta.env.PROD)) ??
    (await rateLimitAssistantRoute(request, env, import.meta.env.PROD));
  if (limited) return copy ? lastGood(request, copy, limited.status) : limited;

  // The same miss is already rendering in this isolate: take its entry instead of a second D1 read. The
  // check and the claim below run with no await between them, so of identical misses exactly one renders.
  const pending = key && inFlight(key.url);
  if (pending) {
    await pending;
    const rendered = await storedCopy(key);
    if (rendered) {
      if (copy) await copy.body?.cancel();
      copy = rendered;
      if (isFresh(copy.headers, Date.now(), generation)) return freshResponse(key, copy);
    }
  }
  const settle = key ? claim(key.url) : () => {};
  let stored: Promise<unknown> = Promise.resolve();
  try {
    let response: Response;
    try {
      response = await requestHandler(request, { cloudflare: { env, ctx } });
    } catch (error) {
      if (!copy) throw error;
      return lastGood(request, copy, 'threw');
    }
    if (copy) {
      // The page cannot be rendered just now — a database that is busy, a fault: the visitor gets the
      // last good copy instead of the error. Anything below a 5xx is the page's own, current answer.
      if (response.status >= 500) {
        await response.body?.cancel();
        return lastGood(request, copy, response.status);
      }
      await copy.body?.cancel();
    }
    const hardened = await finish(request, response, key, ctx, began, generation);
    stored = hardened.stored;
    return hardened.response;
  } finally {
    // Waiting identical misses look the entry up once it is stored (or known not to be).
    void stored.then(settle, settle);
  }
}

// The last good copy in place of an answer the visitor would have been refused; logged, so that how often
// the site leans on it can be counted.
function lastGood(request: Request, copy: Response, cause: number | 'threw'): Response {
  console.warn(JSON.stringify({ edge: 'stale', path: new URL(request.url).pathname, cause }));
  return served(copy, 'STALE');
}

async function finish(
  request: Request,
  response: Response,
  key: Request | null,
  ctx: ExecutionContext,
  began: number,
  generation: string | null,
): Promise<{ response: Response; stored: Promise<unknown> }> {
  // `response.ok` is load-bearing for cache correctness beyond "don't cache errors": cache-key.ts decodes
  // the path (collapsing `%2F` → `/`), so an encoded contract URL (200) and a bogus raw-slash form (404)
  // share ONE key. Because a non-ok response is never put, the 404 form can't poison the encoded entry
  // (#221/#213). Don't drop this gate without re-keying on the raw pathname — the „never caches a non-ok
  // response" test in app.cache.test.ts guards it.
  const cacheable =
    key !== null &&
    response.ok &&
    isAnonymous(request, response) &&
    /s-maxage=\d/.test(response.headers.get('Cache-Control') ?? '');
  const hardened = await hardenResponse(response, cacheable);
  // Set BEFORE the cache put so the stored copy carries it — the HIT path (above) rebuilds headers from the
  // cached response, so a noindex baked into the cached entry is preserved on every subsequent HIT.
  // Outside the production site (stage, dev, a workers.dev twin) every page is noindex, whatever it names.
  if (isNoindexNamesPath(request) || !isIndexedHost(request))
    hardened.headers.set('X-Robots-Tag', 'noindex');
  // Stamped with the moment and the data generation the render BEGAN under: a page that straddles a change
  // of data counts as the older one.
  const stored = cacheable
    ? edgeCache.put(key, stamped(hardened.clone(), began, generation))
    : Promise.resolve();
  ctx.waitUntil(stored);
  hardened.headers.set('X-Edge-Cache', cacheable ? 'MISS' : 'BYPASS');
  return { response: hardened, stored };
}
