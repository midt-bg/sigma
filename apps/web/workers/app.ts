import { createRequestHandler } from "react-router";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE
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

function cacheKey(request: Request): Request {
  const url = new URL(request.url);
  url.searchParams.set("_dt", DEPLOY_TAG);
  return new Request(url.toString(), request);
}

export default {
  async fetch(request, env, ctx) {
    // Per-colo edge cache (Cache API) for GET responses that opt in via Cache-Control: s-maxage=N
    // (publicCache() in apps/web/app/lib/cache.ts). Deterministic and independent of platform
    // HTML-cache heuristics on *.workers.dev; TTL is driven by s-maxage. The X-Edge-Cache:
    // HIT|MISS|BYPASS header lets `curl -I` verify which path a request took.
    const key = request.method === "GET" ? cacheKey(request) : null;
    if (key) {
      const cached = await edgeCache.match(key);
      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set("X-Edge-Cache", "HIT");
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
      /s-maxage=\d/.test(response.headers.get("Cache-Control") ?? "");
    if (cacheable) ctx.waitUntil(edgeCache.put(key, response.clone()));
    response.headers.set("X-Edge-Cache", cacheable ? "MISS" : "BYPASS");
    return response;
  },
} satisfies ExportedHandler<Env>;
