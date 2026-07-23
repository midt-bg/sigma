// Sitemap + robots body-shape integration suite — exercises the sitemap index, the
// four per-type sitemaps, and `/robots.txt` through the real SSR Worker pipeline
// (`apps/web/workers/app.ts`) and asserts that the body parses to the documented
// shape:
//
//   1. Response status is 200 (the route rendered successfully against the seeded D1).
//   2. The shared base security-header set is present (`assertCommonSecurity`).
//   3. `Content-Type` matches the route's actual contract:
//        Sitemaps  → application/xml
//        robots.txt → text/plain
//   4. The response took the first-request path through the edge cache
//      (`X-Edge-Cache: MISS|BYPASS`).
//   5. Body parses as the documented XML shape:
//        /sitemap.xml              → `<?xml …?>\n<sitemapindex xmlns="…">…</sitemapindex>`
//                                    + every child <sitemap> element has a <loc> child.
//        /sitemap-pages.xml        → `<?xml …?>\n<urlset xmlns="…">…</urlset>`
//                                    + at least one known editorial page is listed.
//        /sitemap-contracts.xml    → `<?xml …?>\n<urlset xmlns="…">…</urlset>`
//                                    + at least one <url> entry whose <loc> points to
//                                      `/contracts/1` (seeded by the fixture).
//        /sitemap-companies.xml    → `<?xml …?>\n<urlset xmlns="…">…</urlset>`
//                                    + at least one <url> entry whose <loc> points to
//                                      `/companies/…`.
//        /sitemap-authorities.xml  → `<?xml …?>\n<urlset xmlns="…">…</urlset>`
//                                    + at least one <url> entry whose <loc> points to
//                                      `/authorities/BG000000000` (seeded by the fixture).
//   6. robots.txt body parses to the documented literal lines:
//        `User-agent: *`
//        `Allow: /`
//        `Disallow: /search`
//        `Disallow: /*.csv`
//        `Sitemap: <origin>/sitemap.xml`
//
// Each test sets a distinct `CF-Connecting-IP` so the per-IP rate limiters
// (CSV/SEARCH/AGG/ASSISTANT) get an independent bucket — no test trips a 429.
//
// Why this file exists separately from `routes.test.ts`: `routes.test.ts` asserts
// the *header* contract (status, security headers, content-type). This file asserts
// the *body* contract — that the emitted XML / robots.txt is structurally correct
// for a crawler to consume. The two suites are intentionally isolated so a body
// regression does not get buried in the larger header suite's output.
//
// The proxy is bootstrapped by `./global-setup.ts` (vitest globalSetup); the `caches`
// polyfill is installed by `./polyfills.ts` (vitest setupFiles). This file only adds
// the body-shape assertions.

import { describe, expect, it } from 'vitest';
import { appFetch } from './setup';
import {
  assertCommonSecurity,
  assertEdgeCacheFirstRequest,
  assertSitemapContentType,
  assertTextPlainContentType,
} from './helpers/headers';

const BASE = 'https://sigma.test';

function get(path: string, ip: string): Promise<Response> {
  return appFetch(new Request(`${BASE}${path}`, { headers: { 'CF-Connecting-IP': ip } }));
}

// Sitemap protocol namespace, declared by every emitted <sitemapindex> / <urlset>.
const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';

function assertSitemapXmlns(body: string): void {
  expect(body).toMatch(/^<\?xml\s+version="1\.0"\s+encoding="UTF-8"\?>/);
  expect(body).toContain(`xmlns="${SITEMAP_NS}"`);
}

describe('sitemaps — body shape (issue #94)', () => {
  it('GET /sitemap.xml — sitemapindex references the four per-type sitemaps', async () => {
    const res = await get('/sitemap.xml', '203.0.113.40');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertSitemapContentType(res);
    assertEdgeCacheFirstRequest(res);

    const body = await res.text();
    assertSitemapXmlns(body);

    // sitemapindex root (vs urlset).
    expect(body).toContain('<sitemapindex');
    expect(body).toMatch(/<\/sitemapindex>\s*$/);

    // The four per-type sitemaps are referenced.
    expect(body).toContain(`${BASE}/sitemap-pages.xml`);
    expect(body).toContain(`${BASE}/sitemap-authorities.xml`);
    expect(body).toContain(`${BASE}/sitemap-companies.xml`);
    // Contracts paginate under the 50k-URL sitemap limit; with 30 fixture contracts
    // the index must include exactly one page.
    expect(body).toMatch(new RegExp(`${BASE.replace(/\./g, '\\.')}/sitemap-contracts\\.xml\\?p=1`));

    // Every <sitemap> child must carry a <loc>.
    const sitemapCount = (body.match(/<sitemap>/g) ?? []).length;
    const locCount = (body.match(/<loc>/g) ?? []).length;
    expect(sitemapCount).toBeGreaterThan(0);
    expect(locCount).toBe(sitemapCount);
  });

  it('GET /sitemap-pages.xml — urlset with editorial pages', async () => {
    const res = await get('/sitemap-pages.xml', '203.0.113.41');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertSitemapContentType(res);
    assertEdgeCacheFirstRequest(res);

    const body = await res.text();
    assertSitemapXmlns(body);

    expect(body).toContain('<urlset');
    expect(body).toMatch(/<\/urlset>\s*$/);

    // The hardcoded editorial page set in `apps/web/app/routes/sitemap-pages.tsx`.
    for (const loc of ['/', '/companies', '/authorities', '/contracts', '/privacy', '/impressum']) {
      expect(body).toContain(`<loc>${BASE}${loc}</loc>`);
    }
  });

  it('GET /sitemap-contracts.xml — urlset with the seeded contract URL', async () => {
    const res = await get('/sitemap-contracts.xml', '203.0.113.42');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertSitemapContentType(res);
    assertEdgeCacheFirstRequest(res);

    const body = await res.text();
    assertSitemapXmlns(body);

    expect(body).toContain('<urlset');
    expect(body).toMatch(/<\/urlset>\s*$/);

    // The fixture seeds 30 contracts, the first of which is `c:1` → URL slug `1`.
    // (Streaming routers may emit entries out of source order; the assertion checks
    // presence rather than position.)
    expect(body).toContain(`<loc>${BASE}/contracts/1</loc>`);

    // Every <url> child carries a <loc> (the sitemaps contract).
    const urlCount = (body.match(/<url>/g) ?? []).length;
    const locCount = (body.match(/<loc>/g) ?? []).length;
    expect(urlCount).toBeGreaterThan(0);
    expect(locCount).toBe(urlCount);
  });

  it('GET /sitemap-companies.xml — urlset with the seeded bidder URL', async () => {
    const res = await get('/sitemap-companies.xml', '203.0.113.43');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertSitemapContentType(res);
    assertEdgeCacheFirstRequest(res);

    const body = await res.text();
    assertSitemapXmlns(body);

    expect(body).toContain('<urlset');
    expect(body).toMatch(/<\/urlset>\s*$/);

    // At least one `/companies/...` entry.
    expect(body).toMatch(/<loc>https:\/\/sigma\.test\/companies\/[A-Za-z0-9_-]+<\/loc>/);

    // Every <url> child carries a <loc>.
    const urlCount = (body.match(/<url>/g) ?? []).length;
    const locCount = (body.match(/<loc>/g) ?? []).length;
    expect(urlCount).toBeGreaterThan(0);
    expect(locCount).toBe(urlCount);
  });

  it('GET /sitemap-authorities.xml — urlset with the seeded authority URL', async () => {
    const res = await get('/sitemap-authorities.xml', '203.0.113.44');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertSitemapContentType(res);
    assertEdgeCacheFirstRequest(res);

    const body = await res.text();
    assertSitemapXmlns(body);

    expect(body).toContain('<urlset');
    expect(body).toMatch(/<\/urlset>\s*$/);

    // The fixture seeds authority `auth:BG000000000` → URL slug `BG000000000`.
    expect(body).toContain(`<loc>${BASE}/authorities/BG000000000</loc>`);

    // Every <url> child carries a <loc>.
    const urlCount = (body.match(/<url>/g) ?? []).length;
    const locCount = (body.match(/<loc>/g) ?? []).length;
    expect(urlCount).toBeGreaterThan(0);
    expect(locCount).toBe(urlCount);
  });
});

describe('robots.txt — body shape (issue #94)', () => {
  it('GET /robots.txt — emits the documented literal directives', async () => {
    const res = await get('/robots.txt', '203.0.113.45');
    expect(res.status).toBe(200);
    assertCommonSecurity(res);
    assertTextPlainContentType(res);
    assertEdgeCacheFirstRequest(res);

    const body = await res.text();

    // The robots.txt route is a fixed string (see `apps/web/app/routes/robots.tsx`).
    // The crawler relies on each literal line being present at the start of a row.
    expect(body).toMatch(/^User-agent: \*$/m);
    expect(body).toMatch(/^Allow: \/$/m);
    expect(body).toMatch(/^Disallow: \/search$/m);
    expect(body).toMatch(/^Disallow: \/\*\.csv$/m);
    expect(body).toMatch(new RegExp(`^Sitemap: ${BASE.replace(/\./g, '\\.')}/sitemap\\.xml$`, 'm'));
  });
});