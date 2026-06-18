import { createRequestHandler } from 'react-router';
import { baseSecurityHeaders } from '../app/lib/security';
import { rateLimitAggregationRoute } from './aggregation-rate-limit';
import { cacheKey } from './cache-key';
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

// Evaluated at module-init time, i.e. once per worker deploy. Prefixed into the cache key so a fresh
// deploy automatically invalidates the per-colo edge cache without a manual purge; old entries are
// orphaned and TTL out, new requests populate under the new tag. The Cache API has no namespace
// concept, so we synthesise one by mutating the cache-key URL (the served response is unaffected).
const DEPLOY_TAG = Date.now().toString(36);

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

// Apply the shared base headers and preserve the nonce-based CSP the SSR render already set
// (entry.server.tsx). We deliberately do NOT recompute CSP from the response body: hashing whatever
// inline <script> tags appear would self-authorize any injected inline script on cached pages,
// stripping the very defense CSP is meant to provide. The per-request nonce is stored in the cached
// body alongside this header, so a cache hit serves a self-consistent nonce + CSP; an injected script
// without that nonce is blocked.
function hardenResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  applySecurityHeaders(headers, baseSecurityHeaders(import.meta.env.PROD));
  setAllowHeader(headers, response.status);

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

  const response = await requestHandler(request, { cloudflare: { env, ctx } });
  const cacheable =
    key !== null &&
    response.ok &&
    isAnonymous(request, response) &&
    /s-maxage=\d/.test(response.headers.get('Cache-Control') ?? '');
  const hardened = hardenResponse(response);
  if (cacheable) ctx.waitUntil(edgeCache.put(key, hardened.clone()));
  hardened.headers.set('X-Edge-Cache', cacheable ? 'MISS' : 'BYPASS');
  return hardened;
}
