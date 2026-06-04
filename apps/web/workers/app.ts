import { createRequestHandler } from 'react-router';
import { baseSecurityHeaders, nonceLessSecurityHeaders } from '../app/lib/security';

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
// deploy automatically invalidates the per-colo edge cache without a manual purge — old entries are
// orphaned and TTL out, new requests populate under the new tag. The Cache API has no namespace
// concept, so we synthesise one by mutating the cache-key URL (the served response is unaffected).
const DEPLOY_TAG = Date.now().toString(36);
const INLINE_SCRIPT_RE = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

function cacheKey(request: Request): Request {
  const url = new URL(request.url);
  url.searchParams.set('_dt', DEPLOY_TAG);
  return new Request(url.toString(), request);
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

async function sha256Source(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const binary = String.fromCharCode(...new Uint8Array(digest));
  return `'sha256-${btoa(binary)}'`;
}

async function hashInlineScripts(html: string): Promise<string[]> {
  const scripts = Array.from(html.matchAll(INLINE_SCRIPT_RE), (match) => match[1] ?? '');
  return Promise.all(Array.from(new Set(scripts)).map(sha256Source));
}

async function hardenResponse(response: Response, cacheable: boolean): Promise<Response> {
  const headers = new Headers(response.headers);
  applySecurityHeaders(headers, baseSecurityHeaders(import.meta.env.PROD));

  if (cacheable && isHtml(response)) {
    const body = await response.text();
    applySecurityHeaders(
      headers,
      nonceLessSecurityHeaders(await hashInlineScripts(body), import.meta.env.PROD),
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
    // Per-colo edge cache (Cache API) for GET responses that opt in via Cache-Control: s-maxage=N
    // (publicCache() in apps/web/app/lib/cache.ts). Deterministic and independent of platform
    // HTML-cache heuristics on *.workers.dev; TTL is driven by s-maxage. The X-Edge-Cache:
    // HIT|MISS|BYPASS header lets `curl -I` verify which path a request took.
    const key = request.method === 'GET' ? cacheKey(request) : null;
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
  },
} satisfies ExportedHandler<Env>;
