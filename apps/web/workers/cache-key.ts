// Keep this allow-list in sync with query params consumed by apps/web/app/routes loaders.
export const CACHE_QUERY_PARAMS = new Set([
  'a', // /compare — entity A slug
  'angle', // /trends: time | cpv | cross lens
  'authority',
  'b', // /compare — entity B slug
  'bidder',
  'bids', // /contracts: c.bids_received = 1 — changes the result set and headline totals (CWE-349, #56)
  'by', // /overruns — sort dimension (absolute | percent)
  'center',
  'cohort', // /price-anomaly — selected CPV cohorts (repeatable); faceting changes the result set
  'count',
  'cpv', // /contracts + /trends — exact 5-digit CPV filter; changes the result set + headline totals
  'cpvSort', // /trends: CPV list ordering
  'cursor',
  'eu',
  'funding',
  'kind',
  'metric', // /compare leaderboard dimension
  'p',
  'page', // pagination offset — distinct pages must not share a cache entry
  'procedure',
  'q',
  'sector',
  'sort',
  'step', // /trends: series granularity (m|q|y; replaced the old `g` param)
  'top', // singleSelectFilters: top-20 vs top-50 on /flows and /competition
  'type',
  'value',
  'year',
]);

// Params a loader reads but that intentionally do NOT change the response (so they're safe to omit
// from the cache key). None exist today — every consumed param affects output. This constant is not
// dead: the drift guard in cache-key.test.ts treats `consumed ⊆ CACHE_QUERY_PARAMS ∪
// INTENTIONALLY_UNKEYED` as the invariant, so any future read-but-ignored param must be listed here
// with a justification rather than silently absent (CWE-349, #56).
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
