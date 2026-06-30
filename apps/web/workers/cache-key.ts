// Response-affecting query params: every param a route loader (or the SSR render it feeds) reads off
// the URL must be in this set, or two URLs that yield different responses collapse to one cache entry
// (CWE-349, see issue #56). Keep it in sync with what apps/web/app/{routes,lib/filters.ts} consume.
// The drift guard in cache-key.test.ts statically scans those sources and fails CI if a consumed
// param is missing here (or from INTENTIONALLY_UNKEYED below), so the common case — a literal-key
// read — can't drift unnoticed. It is not absolute: cache-key.test.ts documents the blind spots it
// can't see (dynamic keys like sel(k), and workers/** is out of scope).
export const CACHE_QUERY_PARAMS = new Set([
  'authority',
  'bidder',
  'bids', // /contracts: c.bids_received = 1 — changes the result set and headline totals
  'center',
  'count',
  'cursor',
  'eu',
  'funding',
  'g',
  'kind',
  'p',
  'page', // pageNav: rank offset + "page N of M" in the HTML, but only when cursor is set. Keyed
  // unconditionally — without cursor it's a harmless over-key (never a wrong body); simpler than
  // coupling the key to cursor presence, and q/cursor already make key cardinality client-unbounded.
  'procedure',
  'q',
  'sector',
  'sort',
  'top', // singleSelectFilters: top-20 vs top-50 on /flows and /competition
  'type',
  'value',
  'year',
]);

// Params a loader reads but that intentionally do NOT change the response (so they're safe to omit
// from the cache key). None exist today — every consumed param affects output. This constant is not
// dead: the drift guard treats `consumed ⊆ CACHE_QUERY_PARAMS ∪ INTENTIONALLY_UNKEYED` as the
// invariant, so any future read-but-ignored param must be listed here with a justification rather
// than silently absent.
export const INTENTIONALLY_UNKEYED = new Set<string>([]);

export function cacheKey(request: Request, deployTag: string): Request {
  const url = new URL(request.url);
  const params = new URLSearchParams();

  try {
    url.pathname = decodeURIComponent(url.pathname);
  } catch {
    // Malformed percent-encoding should not break cache lookup; keep the raw path as the fallback.
  }

  for (const [key, value] of url.searchParams) {
    if (CACHE_QUERY_PARAMS.has(key)) params.append(key, value);
  }

  params.sort();
  params.set('_dt', deployTag);
  url.search = params.toString();

  return new Request(url.toString(), request);
}
