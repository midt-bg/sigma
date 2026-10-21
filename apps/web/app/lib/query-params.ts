import { CPV_SECTORS } from '@sigma/config';

// The response-affecting query params, shared by cacheKey (edge cache key) and withParams (link hrefs):
// one list means an unknown param (`?x=poison`) can neither poison the key nor ride a cached link
// (#56 / #197). The cache-key.test.ts drift guard keeps it a complete superset of what the app reads;
// ROUTE_QUERY_PARAMS below narrows it to what each route reads.
export const CANONICAL_QUERY_PARAMS = new Set([
  'authority',
  'authorities', // =all: every buyer in a person's „По възложители" table
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
  'role', // /conflicts — ownership and management, or also the seats on collegial bodies
  'sector',
  'signal', // /conflicts — own institution / in the declared window
  'sort',
  'stake', // /conflicts — own stake vs a relative's
  'top', // top-20 vs top-50 on /flows, /competition
  'type',
  'value',
  'view', // /persons — the profile instead of the list of matching people
  'year',
]);

const LIST = ['cursor', 'eu', 'page', 'q', 'sector', 'sort', 'year'];
const CONTRACTS = [...LIST, 'authority', 'bidder', 'bids', 'procedure', 'value'];
const COMPANIES = [...LIST, 'count', 'kind'];
const AUTHORITIES = [...LIST, 'type'];
const EXPLORER = ['funding', 'sector', 'top', 'year'];
const PERSON = ['authorities', 'authority', 'basis', 'company', 'page', 'view', 'year'];

// The params each route reads, keyed by the route path (lowercase, no `.data`, no trailing slash).
// A route that is not listed reads none: `/?q=…` or `/analytics?p=…` would otherwise mint a fresh cache
// key, and a full D1 read, per unique value. The edge worker also strips the rest from the request the
// loader sees, so a param missing here makes a filter stop working rather than poison the cache.
const ROUTE_QUERY_PARAMS: Record<string, readonly string[]> = {
  '/search': ['q'],
  '/search/suggest': ['q'],
  '/contracts': CONTRACTS,
  '/contracts.csv': CONTRACTS,
  '/companies': COMPANIES,
  '/companies.csv': COMPANIES,
  '/authorities': AUTHORITIES,
  '/authorities.csv': AUTHORITIES,
  '/flows': EXPLORER,
  '/competition': EXPLORER,
  '/map': ['funding', 'sector', 'year'],
  '/trends': ['funding', 'g', 'sector'],
  '/network': ['center'],
  '/conflicts': ['authority', 'institution', 'page', 'q', 'role', 'signal', 'sort', 'stake'],
  '/sitemap-contracts.xml': ['p'],
};

const routePath = (pathname: string) =>
  pathname
    .toLowerCase()
    .replace(/\.data$/, '')
    .replace(/\/+$/, '') || '/';

export function routeQueryParams(pathname: string): readonly string[] {
  const path = routePath(pathname);
  // /conflicts/official/:id is the old address of /persons/:id and forwards the query to it.
  if (/^\/(?:persons|conflicts\/official)\/[^/]+$/.test(path)) return PERSON;
  return ROUTE_QUERY_PARAMS[path] ?? [];
}

// The explorer pages read each of their params once (`sp.get`) and only from a closed set
// (singleSelectFilters), so any other value is folded: one that means „no filter" is dropped, an unknown
// sector or year becomes one placeholder the page still reports as unknown. Elsewhere a free-text param
// (q, authority, cursor, center) is unbounded anyway, and those routes are rate-limited instead.
const UNKNOWN = '_';
const KNOWN_SECTORS = new Set(CPV_SECTORS.map((s) => s.code));
const EXPLORER_VALUE: Record<string, (value: string) => string | null> = {
  sector: (v) => (KNOWN_SECTORS.has(v) ? v : UNKNOWN),
  year: (v) => (/^(?:19|20)\d\d$/.test(v) ? v : UNKNOWN),
  funding: (v) => (v === 'eu' || v === 'national' ? v : null),
  top: (v) => (v === '50' ? v : null),
  g: (v) => (v === 'year' ? v : null),
};
const EXPLORER_PATHS = new Set(['/flows', '/competition', '/map', '/trends']);

/** The query that can change `pathname`'s response: its own params only, values folded on the explorers. */
export function canonicalSearch(pathname: string, search: URLSearchParams): URLSearchParams {
  const allowed = new Set(routeQueryParams(pathname));
  const explorer = EXPLORER_PATHS.has(routePath(pathname));
  const out = new URLSearchParams();
  const seen = new Set<string>();
  for (const [key, value] of search) {
    if (!allowed.has(key)) continue;
    if (!explorer) {
      out.append(key, value);
      continue;
    }
    // `sp.get` reads the first value only, so a repeat is dropped; an empty one is no filter.
    if (seen.has(key)) continue;
    seen.add(key);
    if (value === '') continue;
    const folded = EXPLORER_VALUE[key]!(value);
    if (folded !== null) out.set(key, folded);
  }
  out.sort();
  return out;
}
