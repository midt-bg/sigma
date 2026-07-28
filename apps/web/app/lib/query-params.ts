// The response-affecting query params, shared by cacheKey (edge cache key) and withParams (link hrefs):
// one list means an unknown param (`?x=poison`) can neither poison the key nor ride a cached link
// (#56 / #197). The cache-key.test.ts drift guard keeps it a complete superset of what the app reads.
// Some entries below (a, b, by, cohort, cpv, metric) sit ahead of the routes that will read them
// (/compare, /overruns, /price-anomaly, /contracts cpv filter) — see cache-key.test.ts's
// info-only "stale entries" check for why that's intentional on this stacked-PR base.
export const CANONICAL_QUERY_PARAMS = new Set([
  'a', // /compare — entity A slug
  'authority',
  'b', // /compare — entity B slug
  'bidder',
  'bids', // single-bid filter — changes the result set + totals
  'by', // /overruns — sort dimension (absolute | percent)
  'center',
  'cohort', // /price-anomaly — selected CPV cohorts (repeatable); faceting changes the result set
  'count',
  'cpv', // /contracts — exact 5-digit CPV filter; changes the result set + headline totals
  'cursor',
  'eu',
  'funding',
  'g',
  'kind',
  'metric', // /compare leaderboard dimension
  'p',
  'page', // keyed unconditionally — harmless over-key when there's no cursor
  'procedure',
  'q',
  'sector',
  'sort',
  'top', // top-20 vs top-50 on /flows, /competition
  'type',
  'value',
  'year',
]);

// Read but deliberately not response-affecting: excluded from the cache key, still kept in links. None
// today; declared so a future one isn't silently absent.
export const INTENTIONALLY_UNKEYED = new Set<string>([]);
