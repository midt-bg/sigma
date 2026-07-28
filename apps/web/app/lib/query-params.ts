// The response-affecting query params, shared by cacheKey (edge cache key) and withParams (link hrefs):
// one list means an unknown param (`?x=poison`) can neither poison the key nor ride a cached link
// (#56 / #197). The cache-key.test.ts drift guard keeps it a complete superset of what the app reads.
export const CANONICAL_QUERY_PARAMS = new Set([
  'angle', // /trends: time | cpv | cross lens
  'authority',
  'bidder',
  'bids', // single-bid filter — changes the result set + totals
  'center',
  'count',
  'cpv', // /trends: repeatable CPV group multi-select facet (CWE-349)
  'cpvSort', // /trends: CPV list ordering
  'cur', // /trends: include the current (partial) period — changes the chart, totals and year cards
  'cursor',
  'eu',
  'funding',
  'kind',
  'p',
  'page', // keyed unconditionally — harmless over-key when there's no cursor
  'procedure',
  'q',
  'sector',
  'sort',
  'step', // /trends: series granularity (m|q|y; replaced the old `g` param)
  'top', // top-20 vs top-50 on /flows, /competition
  'type',
  'value',
  'year',
]);

// Read but deliberately not response-affecting: excluded from the cache key, still kept in links. None
// today; declared so a future one isn't silently absent.
export const INTENTIONALLY_UNKEYED = new Set<string>([]);
