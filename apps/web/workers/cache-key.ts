// Keep this allow-list in sync with query params consumed by apps/web/app/routes loaders.
export const CACHE_QUERY_PARAMS = new Set([
  'angle', // /trends: time | cpv | cross lens
  'authority',
  'bidder',
  'bids', // /contracts: c.bids_received = 1 — changes the result set and headline totals (CWE-349, #56)
  'by', // /overruns — sort dimension (absolute | percent)
  'center',
  'count',
  'cpv', // /contracts — exact 5-digit CPV filter; ALSO /trends: repeatable CPV group multi-select faceting the обзор chart + list (CWE-349)
  'cpvSort', // /trends: CPV list ordering
  'cur', // /trends: include the current (partial) period — changes the chart, totals and year cards
  'cursor',
  'eu',
  'funding',
  'g', // RESERVED for #144 — /network graph-only re-centre fetch (?g=1); see RESERVED_CACHE_PARAMS
  'kind',
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

// Allow-list entries keyed AHEAD of their reader: params owned by another OPEN stacked/parallel PR
// whose route lands separately. The reverse drift guard ("no stale allow-list entries") skips
// exactly these, so a key nothing will ever read cannot hide here indefinitely — every entry must
// name its owning PR and is removed (from this set) the moment that PR's reader merges. Keep this
// set minimal.
export const RESERVED_CACHE_PARAMS = new Set<string>([
  'g', // #144 (feat/network-force-layout): /network reads ?g=1 for the graph-only re-centre fetch
]);

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
