// Contract detail + JSON sibling integration suite — exercises the route pair
// `apps/web/app/routes/contract.tsx` (HTML page) and `apps/web/app/routes/contract.json.tsx`
// (machine-readable resource) through the real SSR Worker pipeline
// (`apps/web/workers/app.ts`) and asserts:
//
//   1. Response status is 200 for the seeded contract `c:1` (slug `1`).
//   2. Content-Type matches the route's actual contract:
//        HTML page  → text/html
//        JSON sibling → application/json
//   3. The shared base security-header set is present (`assertCommonSecurity`):
//        X-Content-Type-Options, X-Frame-Options, Referrer-Policy, COOP, CORP,
//        Permissions-Policy, and CSP absent under `import.meta.env.PROD === false`.
//   4. The response took the first-request path through the edge cache
//      (`X-Edge-Cache: MISS|BYPASS`).
//   5. Body shape:
//        HTML page   → body includes the fixture authority name "Authority Test"
//                      (cleanName() leaves ASCII names untouched; see
//                      `packages/shared/src/format.ts`).
//        JSON sibling → body is the `ContractRecord` shape served by
//                       `apps/web/app/routes/contract.json.tsx`:
//                       top-level `id` matches the route slug, plus
//                       `authority.name` / `bidder.name` populated from the
//                       fixture, and the `sourceNames` block the type
//                       contract guarantees.
//   6. 404 path: GET `/contracts/does-not-exist.json` returns 404 with
//      `{ "error": "not_found" }` — the JSON sibling's documented
//      `Response.json({ error: 'not_found' }, { status: 404 })` branch.
//
// Why this file exists separately from `routes.test.ts`: `routes.test.ts` asserts
// only the *header* contract (status, security headers, content-type). This file
// asserts the *body* contract for one route pair — the detail HTML page and its
// JSON sibling — which together form the editor→machine-readable bridge that
// external integrations depend on. A body regression (e.g. the route returning
// the loader wrapper instead of the bare record) would not be caught by the
// header-only suite.
//
// The proxy is bootstrapped by `./global-setup.ts` (vitest globalSetup); the
// `caches` polyfill is installed by `./polyfills.ts` (vitest setupFiles). This
// file only adds the contract-detail assertions.

import { describe, expect, it } from 'vitest';
import { appFetch } from './setup';
import {
  assertCommonSecurity,
  assertEdgeCacheFirstRequest,
  assertHtmlContentType,
  assertJsonContentType,
} from './helpers/headers';

const BASE = 'https://sigma.test';

function get(path: string, ip: string): Promise<Response> {
  return appFetch(new Request(`${BASE}${path}`, { headers: { 'CF-Connecting-IP': ip } }));
}

describe('contract detail + JSON sibling (issue #94)', () => {
  it('GET /contracts/1 — HTML detail page renders with the fixture authority', async () => {
    const res = await get('/contracts/1', '203.0.113.30');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertHtmlContentType(res);
    assertEdgeCacheFirstRequest(res);

    const body = await res.text();
    // The detail page surfaces `c.authority.name` (`cleanName(rawName)`) — the
    // fixture seeds an authority named 'Authority Test', so the rendered HTML
    // must contain that literal string.
    expect(body).toContain('Authority Test');
  });

  it('GET /contracts/1.json — resource route returns the seeded record', async () => {
    const res = await get('/contracts/1.json', '203.0.113.31');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertJsonContentType(res);
    assertEdgeCacheFirstRequest(res);

    const body = await res.text();
    const parsed = JSON.parse(body) as Record<string, unknown>;

    // The JSON sibling returns the `ContractRecord` directly (NOT wrapped in
    // a `{ contract: ... }` envelope — see `apps/web/app/routes/contract.json.tsx`).
    // The top-level `id` is the slug (`contractIdFromSlug('1') === 'c:1'`,
    // `contractSlug('c:1') === '1'`), which matches the route parameter.
    expect(parsed.id).toBe('1');
    expect(typeof parsed.unp).toBe('string');

    // The authority / bidder objects are populated from the fixture.
    expect(parsed.authority).toBeTypeOf('object');
    expect(parsed.authority).not.toBeNull();
    const authority = parsed.authority as Record<string, unknown>;
    expect(authority.name).toBe('Authority Test');
    expect(authority.slug).toBe('BG000000000');

    expect(parsed.bidder).toBeTypeOf('object');
    expect(parsed.bidder).not.toBeNull();
    const bidder = parsed.bidder as Record<string, unknown>;
    expect(bidder.name).toBe('Bidder Test');

    // The ContractRecord contract carries a `sourceNames` block — verbatim
    // names from the source feed. The fixture authority / bidder rows carry
    // these in `name` (no Cyrillic for ASCII test data), so the verbatim form
    // matches the displayed form here.
    expect(parsed.sourceNames).toBeTypeOf('object');
    expect(parsed.sourceNames).not.toBeNull();
    const sourceNames = parsed.sourceNames as Record<string, unknown>;
    expect(sourceNames.authority).toBe('Authority Test');
    expect(sourceNames.bidder).toBe('Bidder Test');
  });

  it('GET /contracts/does-not-exist.json — 404 + { error: "not_found" }', async () => {
    const res = await get('/contracts/does-not-exist.json', '203.0.113.32');
    expect(res.status).toBe(404);
    assertJsonContentType(res);

    const body = await res.text();
    const parsed = JSON.parse(body) as { error?: string };
    expect(parsed.error).toBe('not_found');
  });
});
