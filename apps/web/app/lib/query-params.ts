// The response-affecting query params, shared by cacheKey (edge cache key) and withParams (link hrefs):
// one list means an unknown param (`?x=poison`) can neither poison the key nor ride a cached link
// (#56 / #197). The cache-key.test.ts drift guard keeps it a complete superset of what the app reads.
export const CANONICAL_QUERY_PARAMS = new Set([
  'authority',
  'basis', // evidence basis in the unified person contract list
  'bidder',
  'bids', // single-bid filter — changes the result set + totals
  'center',
  'company', // person profile company filter
  'count',
  'cursor',
  'eu',
  'funding',
  'g',
  'institution', // /conflicts — the official's institution
  'kind',
  'p',
  'page', // keyed unconditionally — harmless over-key when there's no cursor
  'procedure',
  'q',
  'sector',
  'signal', // /conflicts — own institution / in the declared window
  'sort',
  'stake', // /conflicts — own stake vs a relative's
  'top', // top-20 vs top-50 on /flows, /competition
  'type',
  'value',
  'view', // /conflicts/official — the profile instead of the list of matching people
  'year',
]);

// Read but deliberately not response-affecting: excluded from the cache key, still kept in links. None
// today; declared so a future one isn't silently absent.
export const INTENTIONALLY_UNKEYED = new Set<string>([]);
