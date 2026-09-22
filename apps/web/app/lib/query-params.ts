// The response-affecting query params, shared by cacheKey (edge cache key) and withParams (link hrefs):
// one list means an unknown param (`?x=poison`) can neither poison the key nor ride a cached link
// (#56 / #197). The cache-key.test.ts drift guard keeps it a complete superset of what the app reads.
export const CANONICAL_QUERY_PARAMS = new Set([
  'angle', // /trends: time | cpv | cross lens
  'authority',
  'basis', // evidence basis in the unified person contract list
  'bidder',
  'bids', // single-bid filter — changes the result set + totals
  'by', // /overruns — sort dimension (absolute | percent)
  'center',
  'company', // person profile company filter
  'count',
  'cpv', // /trends: repeatable CPV group multi-select facet (CWE-349)
  'cpvSort', // /trends: CPV list ordering
  'cur', // /trends: include the current (partial) period — changes the chart, totals and year cards
  'cursor',
  'eu',
  'funding',
  'institution', // /conflicts — the official's institution
  'kind',
  'p',
  'page', // keyed unconditionally — harmless over-key when there's no cursor
  'procedure',
  'q',
  'sector',
  'signal', // /conflicts — own institution / in the declared window
  'sort',
  'step', // /trends: series granularity (m|q|y; replaced the old `g` param)
  'stake', // /conflicts — own stake vs a relative's
  'top', // top-20 vs top-50 on /flows, /competition
  'type',
  'value',
  'view', // /persons — the profile instead of the list of matching people
  'year',
]);
