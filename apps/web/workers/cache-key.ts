// The cache key is built from the params that change the matched route's response only (CWE-349,
// issue #56); the per-route lists are the shared source of truth in app/lib/query-params.ts.
import { canonicalSearch } from '../app/lib/query-params';
import { normalizedPathname } from './rate-limit';

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

  try {
    // Decoding collapses `%2F` → `/`, so the encoded 200-form of a contract URL (percent-encoded slug,
    // review #221/#213) and a bogus raw-slash 404-form share ONE cache key. This is safe only because
    // app.ts gates cache-put on `response.ok` — the 404 form is never stored, so it can't poison the
    // encoded entry. If that `response.ok` gate is ever removed, this collision brings back the #213
    // cache-poison 404 regression; key on the raw (still-encoded) pathname then instead.
    url.pathname = decodeURIComponent(url.pathname);
  } catch {
    // Malformed percent-encoding should not break cache lookup; keep the raw path as the fallback.
  }

  params.set('_dt', deployTag);
  url.search = params.toString();

  return new Request(url.toString(), request);
}
