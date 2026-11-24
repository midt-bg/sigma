// The cache key is built from the params that change the matched route's response only (CWE-349,
// issue #56); the per-route lists are the shared source of truth in app/lib/query-params.ts.
import { canonicalSearch } from '../app/lib/query-params';
import { normalizedPathname } from './rate-limit';

/**
 * React Router's route discovery (`routeDiscovery.manifestPath`), not a page: it has no entry in the per-route
 * query lists, yet its whole answer depends on `paths` and `version`. Canonicalized, it would lose both and
 * answer every browser with „version mismatch“, which ends in a 404 no request ever reaches the server for.
 */
export function isRouteManifest(request: Request): boolean {
  return new URL(request.url).pathname === '/__manifest';
}

/**
 * The request with only the query its route reads, so the loader renders exactly what the cache key
 * describes: a junk or folded value can never be stored under the key of the canonical URL.
 */
export function canonicalRequest(request: Request): Request {
  const url = new URL(request.url);
  const search = canonicalSearch(normalizedPathname(request), url.searchParams);
  // React Router's `_routes` (some loaders only) is not the page's query, but the loader must see it;
  // app.ts never caches such a request.
  for (const routes of url.searchParams.getAll('_routes')) search.append('_routes', routes);
  const next = search.toString();
  if (next === url.search.slice(1)) return request;
  url.search = next;
  return new Request(url.toString(), request);
}

export function cacheKey(request: Request, deployTag: string): Request {
  const url = new URL(request.url);
  const params = canonicalSearch(normalizedPathname(request), url.searchParams);

  // Keep the router's path segments intact. Decoding the whole pathname would alias an encoded
  // slash inside a slug with a real path separator, so a miss or eviction could affect another route.
  params.set('_dt', deployTag);
  url.search = params.toString();

  return new Request(url.toString(), request);
}
