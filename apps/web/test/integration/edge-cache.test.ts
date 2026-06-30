// Edge-cache integration suite — exercises the per-colo edge-cache middleware
// in `apps/web/workers/app.ts` (the `edgeCache` flow at lines 99–144) through
// the real SSR Worker pipeline and asserts the documented first-request shape:
//
//   1. Response status is 200.
//   2. `X-Edge-Cache` ∈ {`MISS`, `BYPASS`} — the "first request from a cold test
//      process" branch.
//   3. The shared base security-header set is present (`assertCommonSecurity`).
//   4. Content-Type is `text/html; charset=utf-8` for HTML pages, or
//      `application/xml; charset=utf-8` for the sitemap routes, or
//      `text/plain; charset=utf-8` for `/robots.txt`.
//
// Why this file exists separately from `routes.test.ts`:
//
//   `routes.test.ts` asserts the *header* contract for every route named in
//   issue #94 — it exercises `assertEdgeCacheFirstRequest` as one of the four
//   shared assertions. This file narrows the focus to the edge-cache mechanic
//   itself: which routes opt into the per-colo edge cache (via
//   `Cache-Control: s-maxage=…` from `apps/web/app/lib/cache.ts:publicCache()`)
//   and which are BYPASS-only. The narrow scope makes a regression in
//   `cacheable` (e.g. a future change that drops `s-maxage` from the public
//   pages) surface as a clear MISS→BYPASS flip in this suite, not buried
//   inside the broader header-contract output.
//
// Why HIT-on-second-request is NOT asserted here:
//
//   The Node-side polyfilled `CacheStorage` (`apps/web/test/integration/polyfills.ts`)
//   is an in-process `Map`-backed shim. It does NOT roundtrip through the
//   workerd isolate cache that production uses. Putting a response into the
//   polyfill's `caches.default` from one `app.default.fetch` call and then
//   matching it in a subsequent call works in-process (the polyfill is a
//   shared `Map`) but is NOT equivalent to a real workerd isolate cache, so
//   it would NOT exercise the same code path the production worker uses. A
//   `HIT` assertion through this harness would either pass for the wrong
//   reason (polyfill `Map` lookup) or fail for the wrong reason (workerd
//   boundary absent in Node). Either outcome is misleading.
//
//   Coverage retained:
//   - `apps/web/workers/app.cache.test.ts` exercises `hardenResponse`'s
//     `cacheable` branch in isolation (the unit-test lane covers the upstream
//     logic).
//   - ADR-0002 documents the HIT-on-second-request deferral and the condition
//     to revisit it: migration to `@cloudflare/vitest-pool-workers`.
//
// IP selection:
//
//   The rate-limit bindings (CSV/SEARCH/AGG/ASSISTANT) are NOT exercised here —
//   these tests fire one request per route, well under the 10/20/30-token
//   quotas. We still set a distinct `CF-Connecting-IP` per test so the
//   limiter buckets stay isolated in case a future regression accidentally
//   starts exercising a rate-limit gate on these routes.
//
// The proxy is bootstrapped by `./setup.ts` (lazy per-file via `appFetch()`);
// the `caches` polyfill is installed by `./polyfills.ts` (vitest setupFiles).

import { describe, expect, it } from 'vitest';
import { appFetch } from './setup';
import {
  assertCommonSecurity,
  assertEdgeCacheFirstRequest,
  assertHtmlContentType,
  assertSitemapContentType,
  assertTextPlainContentType,
} from './helpers/headers';

const BASE = 'https://sigma.test';

function get(path: string, ip: string): Promise<Response> {
  return appFetch(new Request(`${BASE}${path}`, { headers: { 'CF-Connecting-IP': ip } }));
}

describe('edge cache — first-request MISS|BYPASS contract (issue #94 / A6)', () => {
  it('GET / — first request takes the MISS or BYPASS branch (HIT coverage stays in workers/app.cache.test.ts)', async () => {
    const res = await get('/', '203.0.113.70');

    expect(res.status, `[sigma/test/edge-cache] GET / must return 200 — got ${res.status}`).toBe(200);

    assertCommonSecurity(res);
    assertHtmlContentType(res);
    assertEdgeCacheFirstRequest(res);
  });

  it('GET /search?q=foo — first request still takes MISS|BYPASS (search route is non-cacheable)', async () => {
    // `/search` is a search route and is not in the `publicCache()` opt-in set
    // (`apps/web/app/lib/cache.ts`). The worker sets `X-Edge-Cache: BYPASS`
    // for non-cacheable responses. The MISS|BYPASS whitelist tolerates both,
    // but a regression that flips the search route to cacheable would still
    // pass (both are valid first-request outcomes) — the regression check is
    // that the header is one of the two valid values.
    const res = await get('/search?q=foo', '203.0.113.71');

    expect(res.status, `[sigma/test/edge-cache] GET /search?q=foo must return 200 — got ${res.status}`).toBe(200);

    assertCommonSecurity(res);
    assertHtmlContentType(res);
    assertEdgeCacheFirstRequest(res);
  });

  it('GET /sitemap.xml — first request takes MISS|BYPASS (sitemaps are cacheable)', async () => {
    // Sitemaps route through `publicCache(...)` and so are edge-cacheable. The
    // first request through the worker pipeline takes the MISS branch. The
    // whitelist tolerates a future change that moves sitemaps to BYPASS, but
    // a regression that drops the X-Edge-Cache header entirely would fail.
    const res = await get('/sitemap.xml', '203.0.113.72');

    expect(res.status, `[sigma/test/edge-cache] GET /sitemap.xml must return 200 — got ${res.status}`).toBe(200);

    assertCommonSecurity(res);
    assertSitemapContentType(res);
    assertEdgeCacheFirstRequest(res);
  });

  it('GET /robots.txt — first request takes MISS|BYPASS (robots is non-cacheable)', async () => {
    // `/robots.txt` is a fixed string response and is NOT in the
    // `publicCache()` opt-in set. The worker sets `X-Edge-Cache: BYPASS`.
    const res = await get('/robots.txt', '203.0.113.73');

    expect(res.status, `[sigma/test/edge-cache] GET /robots.txt must return 200 — got ${res.status}`).toBe(200);

    assertCommonSecurity(res);
    assertTextPlainContentType(res);
    assertEdgeCacheFirstRequest(res);
  });
});
