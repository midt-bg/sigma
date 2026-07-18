// The response-affecting query params, shared by cacheKey (edge cache key) and withParams (link hrefs):
// one list means an unknown param (`?x=poison`) can neither poison the key nor ride a cached link
// (#56 / #197). The cache-key.test.ts drift guard keeps it a complete superset of what the app reads.
export const CANONICAL_QUERY_PARAMS = new Set([
  'angle', // /trends: time | cpv | cross lens
  'authority',
  'bidder',
  'bids', // single-bid filter — changes the result set + totals
  'by', // /overruns — sort dimension (absolute | percent)
  'center',
  'count',
  'cpv', // /contracts — exact 5-digit CPV filter; ALSO /trends: repeatable CPV group multi-select faceting the обзор chart + list
  'cpvSort', // /trends: CPV list ordering
  'cur', // /trends: include the current (partial) period — changes the chart, totals and year cards
  'cursor',
  'eu',
  'funding',
  'g',
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

// Allow-list entries keyed AHEAD of their reader: params owned by another OPEN stacked/parallel PR
// whose route lands separately. The reverse drift guard ("no stale allow-list entries") skips
// exactly these, so a key nothing will ever read cannot hide here indefinitely — every entry must
// name its owning PR and is removed (from this set) the moment that PR's reader merges. Keep this
// set minimal.
export const RESERVED_CACHE_PARAMS = new Set<string>([
  'g', // #144 (feat/network-force-layout, still open): /network reads ?g=1 for the graph-only re-centre fetch
]);
