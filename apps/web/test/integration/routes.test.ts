// Header-contract integration suite — exercises the routes named in issue #94 through the
// real SSR Worker pipeline (`apps/web/workers/app.ts`) and asserts:
//
//   1. Response status is 200 (the route rendered successfully against the seeded D1).
//   2. The shared base security-header set is present (`assertCommonSecurity`):
//      X-Content-Type-Options: nosniff
//      X-Frame-Options: DENY
//      Referrer-Policy: strict-origin-when-cross-origin
//      Cross-Origin-Opener-Policy: same-origin
//      Cross-Origin-Resource-Policy: same-origin
//      Permissions-Policy: geolocation=(), microphone=(), camera=()
//      Content-Security-Policy: ABSENT (test lane is `import.meta.env.PROD === false`).
//   3. Content-Type matches the route's actual contract:
//        HTML pages    → text/html
//        Sitemaps      → application/xml
//        robots.txt    → text/plain
//   4. The response took the first-request path through the edge cache
//      (`X-Edge-Cache: MISS|BYPASS`). HIT-on-second-request is intentionally not asserted here:
//      the Node polyfilled CacheStorage does not roundtrip like workerd (see E-P1T1-010/018).
//
// Each test sets a distinct `CF-Connecting-IP` so the per-IP rate limiters
// (CSV/SEARCH/AGG/ASSISTANT) get an independent bucket — no test trips a 429.
//
// The proxy is bootstrapped by `./global-setup.ts` (vitest globalSetup); the `caches` polyfill
// is installed by `./polyfills.ts` (vitest setupFiles). This file only adds the route assertions.

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

describe('routes — header contract (issue #94)', () => {
  it('GET /', async () => {
    const res = await get('/', '203.0.113.10');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertHtmlContentType(res);
    assertEdgeCacheFirstRequest(res);
  });

  it('GET /search (empty query)', async () => {
    const res = await get('/search', '203.0.113.11');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertHtmlContentType(res);
    assertEdgeCacheFirstRequest(res);
  });

  it('GET /search?q=foo', async () => {
    const res = await get('/search?q=foo', '203.0.113.12');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertHtmlContentType(res);
    assertEdgeCacheFirstRequest(res);
  });

  it('GET /companies', async () => {
    const res = await get('/companies', '203.0.113.13');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertHtmlContentType(res);
    assertEdgeCacheFirstRequest(res);
  });

  it('GET /authorities', async () => {
    const res = await get('/authorities', '203.0.113.14');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertHtmlContentType(res);
    assertEdgeCacheFirstRequest(res);
  });

  it('GET /contracts?sort=value-desc', async () => {
    const res = await get('/contracts?sort=value-desc', '203.0.113.15');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertHtmlContentType(res);
    assertEdgeCacheFirstRequest(res);
  });

  it('GET /contracts/1', async () => {
    // contractIdFromSlug('1') → 'c:1', which the global-setup fixture seeds.
    const res = await get('/contracts/1', '203.0.113.16');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertHtmlContentType(res);
    assertEdgeCacheFirstRequest(res);
  });

  it('GET /sitemap.xml', async () => {
    const res = await get('/sitemap.xml', '203.0.113.17');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertSitemapContentType(res);
    assertEdgeCacheFirstRequest(res);
  });

  it('GET /sitemap-pages.xml', async () => {
    const res = await get('/sitemap-pages.xml', '203.0.113.18');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertSitemapContentType(res);
    assertEdgeCacheFirstRequest(res);
  });

  it('GET /sitemap-contracts.xml', async () => {
    const res = await get('/sitemap-contracts.xml', '203.0.113.19');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertSitemapContentType(res);
    assertEdgeCacheFirstRequest(res);
  });

  it('GET /sitemap-companies.xml', async () => {
    const res = await get('/sitemap-companies.xml', '203.0.113.20');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertSitemapContentType(res);
    assertEdgeCacheFirstRequest(res);
  });

  it('GET /sitemap-authorities.xml', async () => {
    const res = await get('/sitemap-authorities.xml', '203.0.113.21');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertSitemapContentType(res);
    assertEdgeCacheFirstRequest(res);
  });

  it('GET /robots.txt', async () => {
    const res = await get('/robots.txt', '203.0.113.22');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertTextPlainContentType(res);
    assertEdgeCacheFirstRequest(res);
  });
});