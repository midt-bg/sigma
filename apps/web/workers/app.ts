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

export default {
  async fetch(request, env, ctx) {
    // Per-colo edge cache (Cache API) for GET responses that opt in via Cache-Control: s-maxage=N
    // (publicCache() in apps/web/app/lib/cache.ts). Deterministic and independent of platform
    // HTML-cache heuristics on *.workers.dev; TTL is driven by s-maxage. The X-Edge-Cache:
    // HIT|MISS|BYPASS header lets `curl -I` verify which path a request took.
    if (request.method === "GET") {
      const cached = await edgeCache.match(request);
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
      request.method === "GET" &&
      response.ok &&
      /s-maxage=\d/.test(response.headers.get("Cache-Control") ?? "");
    if (cacheable) ctx.waitUntil(edgeCache.put(request, response.clone()));
    response.headers.set("X-Edge-Cache", cacheable ? "MISS" : "BYPASS");
    return response;
  },
} satisfies ExportedHandler<Env>;
