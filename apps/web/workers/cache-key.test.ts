import { describe, expect, it } from 'vitest';
import { cacheKey, PLANNED_QUERY_PARAMS } from './cache-key';
import { CANONICAL_QUERY_PARAMS, INTENTIONALLY_UNKEYED } from '../app/lib/query-params';

function cacheUrl(input: string): URL {
  return new URL(cacheKey(new Request(input), 'deploy-test').url);
}

// The edge cache stores rendered SSR HTML, so anything read off the URL during the server render can
// change the response: route loaders, the shared URL-filter helper (companyListParams /
// singleSelectFilters / pageNav), AND server-rendered components (e.g. SiteHeader reads `q`). So we
// scan the whole app/ tree, not just loaders. Loaded as raw text through Vite's glob (workers/* is
// typed for the Cloudflare runtime, so no Node fs here).
const APP_SOURCES: Record<string, string> = import.meta.glob('../app/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

// Statically collect every query param those sources read off the URL. Anchored on the
// URLSearchParams access patterns actually used so it ignores FormData.get() / Headers.has():
//   - a var named sp/searchParams/base, the inline `.searchParams` chain, an inline
//     `new URLSearchParams(...).get(...)` (e.g. root.tsx), and the getMulti() helper.
// Known, accepted blind spots (guard-completeness, not live leaks today):
//   - Dynamic keys: the common `sel('key')` indirection is scanned, but a fully runtime-computed key
//     (`sp.get(someVar)`) can't be resolved statically — keep keys literal so the guard sees them.
//   - Scope: only app/** is scanned. workers/** is excluded because its param reads are
//     infrastructure that does NOT shape the cached body — e.g. request-log.ts reads `q` purely for
//     telemetry (q_present/q_len), and cacheKey itself does the keying. Widening to workers/** would
//     wrongly force log-/rate-limit-only reads into the key. If a worker ever reads a param to shape
//     a cached response, key it explicitly here (better: move that read into a loader under app/).
//   - A new URLSearchParams binding name (other than sp/searchParams/base) needs a pattern added here.
function consumedQueryParams(): Set<string> {
  const patterns = [
    /(?:\bsp|\bsearchParams|\bbase|\.searchParams|URLSearchParams\([^)]*\))\s*\.(?:get|getAll|has)\(\s*['"]([A-Za-z_]\w*)['"]/g,
    /\bgetMulti\(\s*\w+\s*,\s*['"]([A-Za-z_]\w*)['"]/g,
    // The `const sel = (k) => sp.get(k)` helper in the dashboard routes (map/competition/flows/trends).
    /\bsel\(\s*['"]([A-Za-z_]\w*)['"]/g,
  ];

  const found = new Set<string>();
  for (const [path, src] of Object.entries(APP_SOURCES)) {
    if (path.includes('.test.')) continue;
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) found.add(m[1]);
    }
  }
  return found;
}

describe('cacheKey', () => {
  it('drops junk params and keeps the deploy tag', () => {
    const url = cacheUrl('http://local/companies?zqjunk123=1');

    expect(url.pathname).toBe('/companies');
    expect([...url.searchParams]).toEqual([['_dt', 'deploy-test']]);
  });

  it('keeps known params and drops unknown params', () => {
    const url = cacheUrl('http://local/contracts?year=2024&unknown=1&sort=value-desc&q=test');

    expect([...url.searchParams]).toEqual([
      ['q', 'test'],
      ['sort', 'value-desc'],
      ['year', '2024'],
      ['_dt', 'deploy-test'],
    ]);
  });

  it('preserves multi-values for allowed params', () => {
    const url = cacheUrl('http://local/companies?sector=45&kind=company&sector=72');

    expect(url.searchParams.getAll('sector')).toEqual(['45', '72']);
    expect([...url.searchParams]).toEqual([
      ['kind', 'company'],
      ['sector', '45'],
      ['sector', '72'],
      ['_dt', 'deploy-test'],
    ]);
  });

  it('canonicalizes known param order', () => {
    const first = cacheUrl('http://local/authorities?year=2024&type=municipality&eu=eu');
    const second = cacheUrl('http://local/authorities?eu=eu&year=2024&type=municipality');

    expect(first.search).toBe('?eu=eu&type=municipality&year=2024&_dt=deploy-test');
    expect(second.search).toBe(first.search);
  });

  it('canonicalizes percent-encoded path variants', () => {
    const encoded = cacheUrl('http://local/contracts/e%3AUNP-1%3ACONTRACT-1');
    const decoded = cacheUrl('http://local/contracts/e:UNP-1:CONTRACT-1');

    expect(encoded.toString()).toBe(decoded.toString());
    expect(encoded.pathname).toBe('/contracts/e:UNP-1:CONTRACT-1');
  });

  it('keeps genuinely distinct paths distinct', () => {
    const first = cacheUrl('http://local/contracts/e:UNP-1:CONTRACT-1');
    const second = cacheUrl('http://local/contracts/e:UNP-1:CONTRACT-2');

    expect(first.toString()).not.toBe(second.toString());
  });

  it('falls back to the raw pathname for malformed percent-encoding', () => {
    expect(() => cacheUrl('http://local/contracts/%')).not.toThrow();
    expect(cacheUrl('http://local/contracts/%').pathname).toBe('/contracts/%');
  });

  it('keys the /trends „вкл. текущия месец" toggle so the with-current chart gets its own entry (CWE-349)', () => {
    // ?cur=1 re-runs the trend server-side WITH the current partial period — a different chart,
    // different totals and year cards. It must never share a cached SSR body with the default view.
    const base = cacheUrl('http://local/trends');
    const withCurrent = cacheUrl('http://local/trends?cur=1');

    expect(withCurrent.search).not.toBe(base.search);
    expect(withCurrent.searchParams.get('cur')).toBe('1');
  });

  it('keys the repeatable /trends CPV multi-select so faceted charts get their own entries (CWE-349)', () => {
    // The обзор cross lens re-runs the year chart + contract list server-side per selected CPV set;
    // distinct selections (including subsets) must never share one cached SSR body.
    const base = cacheUrl('http://local/trends?angle=cross');
    const one = cacheUrl('http://local/trends?angle=cross&cpv=45233');
    const two = cacheUrl('http://local/trends?angle=cross&cpv=45233&cpv=33600');

    expect(one.search).not.toBe(base.search);
    expect(two.search).not.toBe(one.search);
    expect(two.searchParams.getAll('cpv')).toEqual(['33600', '45233']); // sorted, both values keyed
    // cacheKey() sorts `cpv` values by value (not just by URLSearchParams.sort()'s per-key
    // stability), so a differently-ordered request for the same set collapses to one cache entry
    // instead of fragmenting the edge cache.
    expect(cacheUrl('http://local/trends?angle=cross&cpv=33600&cpv=45233').search).toBe(
      two.search,
    );
  });

  it('keys response-affecting params so they cannot collapse to one cache entry (CWE-349, #56)', () => {
    // ?bids=1 narrows /contracts to single-bid contracts — different rows and totals.
    expect(cacheUrl('http://local/contracts?bids=1').search).not.toBe(
      cacheUrl('http://local/contracts').search,
    );
    // Same cursor, different page marker => different rank numbers in the rendered HTML.
    expect(cacheUrl('http://local/contracts?cursor=c5&page=2').search).not.toBe(
      cacheUrl('http://local/contracts?cursor=c5&page=5').search,
    );
  });
});

describe('CANONICAL_QUERY_PARAMS drift guard', () => {
  it('covers every query param the app reads off the URL (CWE-349, #56)', () => {
    const consumed = consumedQueryParams();
    // Sanity: the scanner must actually find params, else a regex/glob change silently disarms it.
    expect(consumed.size).toBeGreaterThan(10);
    expect(consumed.has('bids')).toBe(true);
    expect(consumed.has('page')).toBe(true);

    // Security direction: every param a route loader / SSR render consumes must be keyed (in the
    // allow-list) or explicitly declared response-neutral, or two distinct views collapse to one
    // cache entry and the wrong data gets served. The reverse direction (allow-list entries nothing
    // reads yet) is intentionally NOT asserted: params for stacked-later routes legitimately sit in
    // the allow-list ahead of their route.
    const allowed = new Set([...CANONICAL_QUERY_PARAMS, ...INTENTIONALLY_UNKEYED]);
    const undeclared = [...consumed].filter((p) => !allowed.has(p)).sort();
    expect(undeclared).toEqual([]);
  });

  // Soft-fails (doesn't block unrelated PRs) rather than a hard failure, because allow-list entries
  // legitimately sit ahead of their route for stacked-later work — but `expect.soft` still reports the
  // stale entries as a visible failure in CI output, unlike a bare `console.info`, so a real drift
  // (e.g. a typo like `bidz` instead of `bids`) is caught rather than silently going unnoticed forever.
  it('flags (without hard-failing) allow-list entries nothing currently reads', () => {
    const consumed = consumedQueryParams();
    const stale = [...CANONICAL_QUERY_PARAMS]
      .filter((p) => !consumed.has(p) && !PLANNED_QUERY_PARAMS.has(p))
      .sort();
    expect.soft(stale).toEqual([]);
  });
});
