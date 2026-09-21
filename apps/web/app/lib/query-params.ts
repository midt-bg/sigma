// The response-affecting query params, shared by cacheKey (edge cache key) and withParams (link hrefs):
// one list means an unknown param (`?x=poison`) can neither poison the key nor ride a cached link
// (#56 / #197). The cache-key.test.ts drift guard keeps it a complete superset of what the app reads.
export const CANONICAL_QUERY_PARAMS = new Set([
  'angle', // /trends: time | cpv | cross lens
  'authority',
  'band', // /quality: histogram score-band filter on the contracts list — changes rows (CWE-349)
  'basis', // evidence basis in the unified person contract list
  'bidder',
  'bids', // single-bid filter — changes the result set + totals
  'center',
  'company', // person profile company filter
  'contract', // /quality: scorecard subject
  'count',
  'cpv', // /trends: 5-digit CPV group filter
  'cpvSort', // /trends: CPV list ordering
  'csort', // /quality: contract list ordering
  'cursor',
  'eu',
  'funding',
  'g', // /trends: retired granularity param (#197 back-compat); still response-affecting when `step` is absent
  'grain', // /quality: rollup grain (authority|supplier|sector|region|year|funding)
  'institution', // /conflicts — the official's institution
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
