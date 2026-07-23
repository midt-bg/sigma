import { createRequestHandler } from 'react-router';
import { baseSecurityHeaders, nonceLessSecurityHeaders } from '../app/lib/security';
import { rateLimitAggregationRoute } from './aggregation-rate-limit';
import { rateLimitAssistantRoute } from './assistant-rate-limit';
import { rateLimitConflictsRoute } from './conflicts-rate-limit';
import { normalizedPathname } from './rate-limit';
import { cacheKey } from './cache-key';
import { cspNonce, hashTrustedInlineScripts } from './csp';
import { rateLimitCsvExport } from './csv-rate-limit';
import { optionsResponse, redirectCleartextHttp, setAllowHeader } from './http';
import { rateLimitSearchRoute } from './search-rate-limit';
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

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const httpsRedirect = redirectCleartextHttp(request, import.meta.env.PROD);
  if (httpsRedirect) return httpsRedirect;

  if (request.method === 'OPTIONS') return optionsResponse(import.meta.env.PROD);

  const csvRateLimitResponse = await rateLimitCsvExport(request, env, import.meta.env.PROD);
  if (csvRateLimitResponse) return csvRateLimitResponse;

  // Per-colo edge cache (Cache API) for GET responses that opt in via Cache-Control: s-maxage=N
  // (publicCache() in apps/web/app/lib/cache.ts). Deterministic and independent of platform
  // HTML-cache heuristics on *.workers.dev; TTL is driven by s-maxage. The X-Edge-Cache:
  // HIT|MISS|BYPASS header lets `curl -I` verify which path a request took.
  const key = request.method === 'GET' ? cacheKey(request, DEPLOY_TAG) : null;
  if (key) {
    const cached = await edgeCache.match(key);
    if (cached) {
      const headers = new Headers(cached.headers);
      applySecurityHeaders(headers, baseSecurityHeaders(import.meta.env.PROD));
      headers.set('X-Edge-Cache', 'HIT');
      return new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers,
      });
    }
  }

  const aggregationRateLimitResponse = await rateLimitAggregationRoute(
    request,
    env,
    import.meta.env.PROD,
  );
  if (aggregationRateLimitResponse) return aggregationRateLimitResponse;

  const searchRateLimitResponse = await rateLimitSearchRoute(request, env, import.meta.env.PROD);
  if (searchRateLimitResponse) return searchRateLimitResponse;

  const assistantRateLimitResponse = await rateLimitAssistantRoute(
    request,
    env,
    import.meta.env.PROD,
  );
  if (assistantRateLimitResponse) return assistantRateLimitResponse;

  // /conflicts* names public officials and its .data twin serves each loader — throttle the subtree so it
  // can't be bulk-scraped into a names export. After the cache check, so cached leaderboard hits are free.
  const conflictsRateLimitResponse = await rateLimitConflictsRoute(
    request,
    env,
    import.meta.env.PROD,
  );
  if (conflictsRateLimitResponse) return conflictsRateLimitResponse;

  const response = await requestHandler(request, { cloudflare: { env, ctx } });
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
  if (isNoindexNamesPath(request)) hardened.headers.set('X-Robots-Tag', 'noindex');
  if (cacheable) ctx.waitUntil(edgeCache.put(key, hardened.clone()));
  hardened.headers.set('X-Edge-Cache', cacheable ? 'MISS' : 'BYPASS');
  return hardened;
}
