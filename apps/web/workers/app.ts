import { createRequestHandler } from 'react-router';
import { inReadSession } from '@sigma/db';
import { isIndexedHost } from '../app/lib/indexing';
import { baseSecurityHeaders, nonceLessSecurityHeaders } from '../app/lib/security';
import { rateLimitAggregationRoute } from './aggregation-rate-limit';
import { rateLimitAssistantRoute } from './assistant-rate-limit';
import { normalizedPathname } from './rate-limit';
import { cacheKey, canonicalRequest, isRouteManifest } from './cache-key';
import { cacheReadToken, trackWrite, withdraw } from './cache-fence';
import { cspNonce, hashTrustedInlineScripts } from './csp';
import {
  degraded,
  type DegradedPart,
  edgeTtl,
  entryId,
  isFresh,
  stamped,
  unstamp,
} from './edge-entry';
import { rateLimitCsvExport } from './csv-rate-limit';
import {
  optionsResponse,
  redirectCleartextHttp,
  redirectToCanonicalPath,
  setAllowHeader,
} from './http';
import { rateLimitSearchRoute } from './search-rate-limit';
import { GENERATION_HEADER, HEALTH_PATH, healthResponse, VERSION_HEADER } from './health';
import { sigmaVersion } from '../app/lib/meta';
import { enterFlight, type FlightOutcome, type RenderOwner } from './render-gate';
import { withRequestLog } from './request-log';

declare module 'react-router' {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
    /** A loader that served the page without one of its parts (D1 refused that read) says so here;
     *  the response then stays at the edge only briefly. Absent outside the worker. */
    markDegraded?: (part: DegradedPart) => void;
    /** The root loader names the data generation it read (`home_totals.refreshed_at`); the worker stamps
     *  it on the response (X-Sigma-Generation, workers/health.ts). Absent outside the worker. */
    markGeneration?: (generation: string) => void;
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

function discard(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

async function cachedResponse(key: Request): Promise<Response | null> {
  const token = cacheReadToken(key.url);
  if (!token) return null;

  let copy: Response | undefined;
  let conditional: Response | undefined;
  let cached: Response | undefined;
  try {
    copy = await edgeCache.match(new Request(key.url));
    if (!copy || !token.unchanged() || !isFresh(copy.headers, Date.now())) return null;

    if (CONDITIONAL.some((name) => key.headers.has(name))) {
      conditional = await edgeCache.match(key);
      // A second lookup can race withdrawal, expiry, eviction or replacement. Its response
      // must still describe the full entry we checked, under the same withdrawal token.
      if (
        !conditional ||
        entryId(conditional.headers) !== entryId(copy.headers) ||
        !token.unchanged() ||
        !isFresh(copy.headers, Date.now())
      )
        return null;
    }
    cached = conditional ?? copy;
  } catch {
    // Cache API errors are misses. Release any body acquired before the failing lookup.
    return null;
  } finally {
    token.release();
    if (copy && copy !== cached) discard(copy);
    if (conditional && conditional !== cached) discard(conditional);
  }

  const headers = new Headers(cached.headers);
  if (copy && cached !== copy) {
    headers.set('Cache-Control', copy.headers.get('Cache-Control') ?? 'no-store');
    // A 304 carries what the cache put on it; the full copy's own headers, the build and data
    // generation among them, are copied over.
    for (const name of [
      'Content-Type',
      'Content-Security-Policy',
      'X-Robots-Tag',
      VERSION_HEADER,
      GENERATION_HEADER,
    ]) {
      const value = copy.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
  }
  unstamp(headers);
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

function hasCredentials(request: Request): boolean {
  return request.headers.has('Authorization') || request.headers.has('Cookie');
}

// These summaries only expose regional and time aggregates. Home, analytics, competition and
// flows surface individual contracts or named entities, including in their full .data responses.
const REPLICA_ROUTES = new Set(['/map', '/trends']);

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
    request.signal,
  );
  // Apply after respond has cloned the edge entry, including on HIT and single-flight HIT. The
  // browser must consult this deployment on every navigation; s-maxage/SWR belong only to the
  // internal edge copy. Otherwise a browser can replay an old response after a deployment rotates
  // the edge keys. Fingerprinted assets and downloadable resources keep their own cache policy.
  const headers = new Headers(response.headers);
  if (response.status >= 500) {
    headers.set('Cache-Control', 'no-store');
    if (response.status === 503) headers.set('Retry-After', '30');
  } else if (response.status === 429 || hasCredentials(request)) {
    headers.set('Cache-Control', 'no-store');
  } else if (
    (isHtml(response) ||
      new URL(request.url).pathname.endsWith('.data') ||
      (edgeTtl(headers) > 0 &&
        (isNoindexNamesPath(request) ||
          (headers.get('X-Robots-Tag') === 'noindex' &&
            headers.get('Content-Type')?.startsWith('application/json'))))) &&
    !/\b(?:no-store|private)\b/i.test(headers.get('Cache-Control') ?? '')
  ) {
    headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  }
  if (request.method === 'HEAD') discard(response);
  return new Response(request.method === 'HEAD' ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function respond(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  signal: AbortSignal,
): Promise<Response> {
  const httpsRedirect = redirectCleartextHttp(request, import.meta.env.PROD);
  if (httpsRedirect) return httpsRedirect;
  const canonicalRedirect = redirectToCanonicalPath(request, import.meta.env.PROD);
  if (canonicalRedirect) return canonicalRedirect;

  if (request.method === 'OPTIONS') return optionsResponse(import.meta.env.PROD);

  // Answered before the cache is consulted: never looked up, never stored, always this deployment.
  if (new URL(request.url).pathname === HEALTH_PATH)
    return healthResponse(request, env, import.meta.env.PROD);

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
  // Local development always reads its current database/code.
  // A `.data` request with `_routes` asks React Router for SOME of the route loaders only. The key does not
  // carry `_routes`, so storing that partial answer would serve it as the whole page's data to every later
  // navigation in the colo — and serving the whole answer to it would be wrong the other way. Neither is
  // looked up nor stored; the app's own navigations do not send `_routes`.
  const key =
    !import.meta.env.DEV &&
    request.method === 'GET' &&
    !routeManifest &&
    !hasCredentials(request) &&
    !new URL(request.url).searchParams.has('_routes')
      ? cacheKey(request, DEPLOY_TAG)
      : null;
  const hit = key && (await cachedResponse(key));
  if (hit) return hit;

  const limited =
    (await rateLimitAggregationRoute(request, env, import.meta.env.PROD)) ??
    (await rateLimitSearchRoute(request, env, import.meta.env.PROD)) ??
    (await rateLimitAssistantRoute(request, env, import.meta.env.PROD));
  if (limited) return limited;

  if (!key) return render(request, env, ctx);

  let flight = enterFlight(key.url, signal);
  // A cohort shares at most one recovery flight. Even a fulfilled put may have stored nothing.
  for (let attempt = 0; flight; attempt++) {
    if (!('wait' in flight)) return render(request, env, ctx, key, flight);
    const outcome = await flight.wait;
    if (typeof outcome === 'number') return renderFailure(outcome, request);
    if (outcome === 'put-complete') {
      const stored = await cachedResponse(key);
      if (stored) return stored;
    }
    flight = attempt === 0 ? flight.recover() : null;
  }
  return renderFailure(503, request);
}

function renderFailure(status: number, request: Request): Response {
  const headers = baseSecurityHeaders(import.meta.env.PROD);
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  headers.set('X-Edge-Cache', 'BYPASS');
  if (isNoindexNamesPath(request) || !isIndexedHost(request))
    headers.set('X-Robots-Tag', 'noindex');
  return new Response(
    status === 503
      ? 'Сайтът е временно недостъпен. Опитайте отново след малко.'
      : 'Възникна грешка при зареждането на страницата.',
    { status, headers },
  );
}

function withdrawsEntry(request: Request, response: Response): boolean {
  const { status } = response;
  if (response.headers.has('Set-Cookie')) return false;
  // React Router's single-fetch transport sends redirects using 202 and a streamed payload.
  const redirect =
    (status >= 300 && status < 400 && status !== 304) ||
    (status === 202 && new URL(request.url).pathname.endsWith('.data'));
  const optedOut =
    status === 200 &&
    /\b(?:private|no-store|no-cache)\b/i.test(response.headers.get('Cache-Control') ?? '');
  return redirect || optedOut || status === 404 || status === 410;
}

async function render(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  key?: Request,
  owner?: RenderOwner,
): Promise<Response> {
  const began = Date.now();
  let writing = false;
  let outcome: FlightOutcome = 'bypass';
  try {
    const readEnv = REPLICA_ROUTES.has(normalizedPathname(request)) ? inReadSession(env) : env;
    let part = null as DegradedPart | null;
    let generation = null as string | null;
    const rendered = await requestHandler(request, {
      cloudflare: { env: readEnv, ctx },
      markDegraded: (missing) => void (part = missing),
      markGeneration: (read) => void (generation = read),
    });
    const response = part ? degraded(rendered, part) : rendered;
    if (response.status >= 500) outcome = response.status;
    const ttl = edgeTtl(response.headers);
    const cacheable = response.status === 200 && ttl > 0 && !response.headers.has('Set-Cookie');
    const hardened = await hardenResponse(response, Boolean(key && cacheable));

    if (isNoindexNamesPath(request) || !isIndexedHost(request))
      hardened.headers.set('X-Robots-Tag', 'noindex');
    hardened.headers.set('X-Edge-Cache', 'BYPASS');
    // Set before the edge copy is taken, so a HIT names the build and the data it was rendered from.
    if (sigmaVersion()) hardened.headers.set(VERSION_HEADER, sigmaVersion());
    if (generation) hardened.headers.set(GENERATION_HEADER, generation);
    if (!key || !owner) return hardened;

    // Once ownership ends, the response can no longer be delivered or change this cache key.
    if (!owner.isCurrent()) {
      discard(hardened);
      outcome = 503;
      return renderFailure(503, request);
    }

    if (!cacheable) {
      if (withdrawsEntry(request, hardened)) {
        hardened.headers.set('Cache-Control', 'no-store');
        const release = withdraw(key.url);
        try {
          await edgeCache.delete(new Request(key.url));
          release();
        } catch {
          // Keep the withdrawal fence until any superseded entry is ineligible to serve.
        }
      }
      return hardened;
    }

    const expires = began + ttl * 1000;
    const release = trackWrite(key.url, expires);
    if (!release) {
      hardened.headers.set('Cache-Control', 'no-store');
      return hardened;
    }
    try {
      const stored = stamped(hardened.clone(), expires);
      owner.beginPut(expires);
      ctx.waitUntil(storeCopy(key.url, stored, owner, expires, release));
    } catch (error) {
      release();
      discard(hardened);
      throw error;
    }
    writing = true;
    hardened.headers.set('X-Edge-Cache', 'MISS');
    return hardened;
  } catch {
    // This also covers failures while buffering HTML for the CSP rewrite. Once a resource has
    // started streaming, a later body error still reaches its consumer through the stream.
    outcome = 500;
    return renderFailure(500, request);
  } finally {
    if (!writing) owner?.settle(outcome);
  }
}

async function storeCopy(
  url: string,
  stored: Response,
  owner: RenderOwner,
  expires: number,
  release: () => void,
): Promise<void> {
  const key = new Request(url);
  let outcome: FlightOutcome = 500;
  try {
    await edgeCache.put(key, stored);
    outcome = 'put-complete';
  } catch {
    discard(stored);
    // A rejected write wakes its waiters without sending them back to the database.
  }
  try {
    if (!owner.isCurrent() && Date.now() < expires) {
      await edgeCache.delete(key);
      outcome = 503;
    }
    release();
  } catch {
    // Retain the read fence through the old entry's freshness limit if cleanup failed.
    outcome = 503;
  } finally {
    owner.settle(outcome);
  }
}
