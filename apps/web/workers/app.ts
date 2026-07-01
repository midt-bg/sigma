import { createRequestHandler } from 'react-router';
import {
  applyPrivacyMaskHeaders,
  baseSecurityHeaders,
  nonceLessSecurityHeaders,
} from '../app/lib/security';
import { rateLimitAggregationRoute } from './aggregation-rate-limit';
import { rateLimitAssistantRoute } from './assistant-rate-limit';
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

function isHtml(response: Response): boolean {
  return (response.headers.get('Content-Type') ?? '').toLowerCase().includes('text/html');
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
  applyPrivacyMaskHeaders(headers);

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

  const response = await requestHandler(request, { cloudflare: { env, ctx } });
  const cacheable =
    key !== null &&
    response.ok &&
    isAnonymous(request, response) &&
    /s-maxage=\d/.test(response.headers.get('Cache-Control') ?? '');
  const hardened = await hardenResponse(response, cacheable);
  if (cacheable) ctx.waitUntil(edgeCache.put(key, hardened.clone()));
  hardened.headers.set('X-Edge-Cache', cacheable ? 'MISS' : 'BYPASS');
  return hardened;
}
