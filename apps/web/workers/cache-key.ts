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
  'cpv', // /contracts — exact 5-digit CPV filter; ALSO /trends: repeatable CPV group multi-select faceting the обзор chart + list (CWE-349)
  'cpvSort', // /trends: CPV list ordering
  'cur', // /trends: include the current (partial) period — changes the chart, totals and year cards
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

// Allow-list entries added ahead of their route — stacked-later work for /compare (`a`, `b`,
// `metric`), /overruns (`by`), and /price-anomaly (`cohort`). The cache-key.test.ts drift guard's
// stale-entry check treats these as expected-not-yet-consumed rather than flagging them, so a real
// drift (e.g. a `bidz` typo instead of `bids`) still surfaces while these documented, planned
// entries don't block unrelated PRs. When one of these routes ships and reads its param, it simply
// becomes "consumed" and this listing becomes a no-op for it — safe to leave or prune then.
export const PLANNED_QUERY_PARAMS = new Set<string>(['a', 'b', 'by', 'cohort', 'metric']);

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

  // The /trends CPV multi-select is a set, not a sequence — `cpv=A&cpv=B` and `cpv=B&cpv=A` select
  // the same group and must render the same SSR body. Canonicalize value order here (not just rely
  // on the UI writing pre-sorted hrefs) so distinct request orderings for an equal set never
  // fragment the edge cache into duplicate entries.
  const cpvValues = params.getAll('cpv').sort();
  if (cpvValues.length > 0) {
    params.delete('cpv');
    for (const v of cpvValues) params.append('cpv', v);
  }

  params.sort();
  params.set('_dt', deployTag);
  url.search = params.toString();

  return new Request(url.toString(), request);
}
