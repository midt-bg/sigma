// The response-affecting query params, shared by cacheKey (edge cache key) and withParams (link hrefs):
// one list means an unknown param (`?x=poison`) can neither poison the key nor ride a cached link
// (#56 / #197). The cache-key.test.ts drift guard keeps it a complete superset of what the app reads.
export const CANONICAL_QUERY_PARAMS = new Set([
  'angle', // /trends: time | cpv | cross lens
  'authority',
  'band', // /quality: histogram score-band filter on the contracts list — changes rows (CWE-349)
  'bidder',
  'bids', // single-bid filter — changes the result set + totals
  'center',
  'contract', // /quality: scorecard subject
  'count',
  'cpv', // /trends: 5-digit CPV group filter
  'cpvSort', // /trends: CPV list ordering
  'csort', // /quality: contract list ordering
  'cursor',
  'eu',
  'funding',
  'grain', // /quality: rollup grain (authority|supplier|sector|region|year|funding)
  'kind',
  'p',
  'page', // keyed unconditionally — harmless over-key when there's no cursor
  'procedure',
  'q',
  'rdir', // /quality: „Разбивка" ranking direction (asc|desc) — flips the rendered row order (CWE-349)
  'rfrom', // /quality: „Разбивка" avg-index range lower bound — changes the rendered rows (CWE-349)
  'rto', // /quality: „Разбивка" avg-index range upper bound — changes the rendered rows (CWE-349)
  'sector',
  'sel', // /quality: selected ranking row scoping the contract list
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
