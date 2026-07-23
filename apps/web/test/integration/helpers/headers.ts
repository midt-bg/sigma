// Response-header assertion helpers for the integration-test lane.
//
// Each helper takes a `Response` plus optional context (status, URL) and produces
// a vitest assertion (or a series of assertions) that fails with a useful message
// if the runtime contract drifts. The helpers are intentionally narrow — they
// cover the header contract that the worker + React Router routes are committed
// to, not a generic HTTP assertion library.
//
// Why these helpers exist as a separate module:
//   1. The same six security headers + "CSP absent in test" + Permissions-Policy
//      substring are asserted on every route response. A shared helper gives one
//      place to update the expected set if a header is added/removed.
//   2. The "first-request edge cache" assertion (MISS|BYPASS whitelist) is a
//      distinct semantics from the second-request HIT path (which is falsified
//      in E-P1T1-010 / E-P1T1-018 — the Node polyfilled CacheStorage does not
//      roundtrip like workerd). The whitelist keeps the false HIT from leaking
//      into the assertion.
//   3. The CSV/JSON/HTML content-type assertions match the actual charset the
//      worker emits ("text/html", "application/json; charset=utf-8",
//      "text/csv; charset=utf-8") via `toMatch(/^text\/html\b/)` style checks so
//      future charset tweaks don't break the suite.
//
// Each helper throws a descriptive `Error` via `expect().toX(...)`; the failure
// message includes the actual header value so the verifier can pinpoint the drift.

import { expect } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function header(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (value === null) {
    throw new Error(
      `[sigma/test/headers] response is missing header \`${name}\`. Got: ${JSON.stringify(
        Object.fromEntries(headers.entries()),
      )}`,
    );
  }
  return value;
}

function formatUrl(response: Response): string {
  return response.url || '<no url>';
}

// ---------------------------------------------------------------------------
// Content-Type assertions
// ---------------------------------------------------------------------------

/**
 * Assert the response carries an `Content-Type: text/html` header.
 *
 * Accepts any leading type with the `text/html` token (charset, boundary, etc.
 * are allowed to follow). The match is case-insensitive — some intermediaries
 * lowercase the token; the underlying `Headers.get` is already case-insensitive
 * for the key.
 */
export function assertHtmlContentType(response: Response): void {
  const ct = header(response.headers, 'Content-Type');
  expect(ct.toLowerCase()).toMatch(/^text\/html(?:\s|;|$)/);
}

/**
 * Assert the response carries an `Content-Type: application/json` header.
 */
export function assertJsonContentType(response: Response): void {
  const ct = header(response.headers, 'Content-Type');
  expect(ct.toLowerCase()).toMatch(/^application\/json(?:\s|;|$)/);
}

/**
 * Assert the response carries an `Content-Type: text/csv` header.
 *
 * The CSV resource routes emit `text/csv; charset=utf-8` (see
 * `apps/web/app/lib/csv-export.ts`); the regex tolerates the charset suffix.
 */
export function assertCsvContentType(response: Response): void {
  const ct = header(response.headers, 'Content-Type');
  expect(ct.toLowerCase()).toMatch(/^text\/csv(?:\s|;|$)/);
}

/**
 * Assert the response carries an `Content-Type: application/xml` header.
 *
 * The sitemap routes (`sitemap.xml`, `sitemap-pages.xml`, `sitemap-contracts.xml`,
 * `sitemap-companies.xml`, `sitemap-authorities.xml`) emit
 * `application/xml; charset=utf-8` (see `apps/web/app/routes/sitemap*.tsx` and
 * `packages/db/src/queries/sitemaps.ts`). The regex tolerates the charset suffix.
 */
export function assertSitemapContentType(response: Response): void {
  const ct = header(response.headers, 'Content-Type');
  expect(ct.toLowerCase()).toMatch(/^application\/xml(?:\s|;|$)/);
}

/**
 * Assert the response carries an `Content-Type: text/plain` header.
 *
 * The robots.txt route emits `text/plain; charset=utf-8` (see
 * `apps/web/app/routes/robots.tsx`); the regex tolerates the charset suffix.
 */
export function assertTextPlainContentType(response: Response): void {
  const ct = header(response.headers, 'Content-Type');
  expect(ct.toLowerCase()).toMatch(/^text\/plain(?:\s|;|$)/);
}

// ---------------------------------------------------------------------------
// Security-header assertions
// ---------------------------------------------------------------------------

/**
 * Assert the response carries the documented base security-header set:
 *   X-Content-Type-Options: nosniff
 *   X-Frame-Options: DENY
 *   Referrer-Policy: strict-origin-when-cross-origin
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Resource-Policy: same-origin
 *   Permissions-Policy: contains geolocation=(), microphone=(), camera=()
 *
 * In the test lane (`import.meta.env.PROD === false`) the worker does NOT emit
 * `Content-Security-Policy` — the production nonce-based CSP is omitted so
 * Vite's HMR + inline scripts can run. This helper asserts that omission
 * explicitly: "CSP must be ABSENT in the test lane". If a future change starts
 * emitting CSP under test, this assertion will fail and force the author to
 * update both the test contract and the production-emission logic in tandem.
 *
 * Strict-Transport-Security is also PROD-only (see `apps/web/app/lib/security.ts`
 * `baseSecurityHeaders`); the helper ignores it for the same reason.
 *
 * Permissions-Policy is asserted as a substring check on each forbidden
 * feature rather than full-string equality so future additions (e.g. a new
 * `payment=()` directive) do not silently break the suite — the worker's
 * documented contract covers geolocation / microphone / camera today.
 */
export function assertCommonSecurity(response: Response): void {
  const h = response.headers;

  expect(header(h, 'X-Content-Type-Options')).toBe('nosniff');
  expect(header(h, 'X-Frame-Options')).toBe('DENY');
  expect(header(h, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  expect(header(h, 'Cross-Origin-Opener-Policy')).toBe('same-origin');
  expect(header(h, 'Cross-Origin-Resource-Policy')).toBe('same-origin');

  const pp = header(h, 'Permissions-Policy');
  expect(pp).toContain('geolocation=()');
  expect(pp).toContain('microphone=()');
  expect(pp).toContain('camera=()');

  // CSP must be absent under `import.meta.env.PROD === false`. The worker
  // applies the per-request nonce-based CSP only in production (see
  // `apps/web/app/lib/security.ts` and `workers/app.ts`).
  const csp = h.get('Content-Security-Policy');
  expect(csp, `[sigma/test/headers] Content-Security-Policy must be absent in the test lane for ${formatUrl(response)} — got ${JSON.stringify(csp)}`).toBeNull();
}

// ---------------------------------------------------------------------------
// Cache assertions
// ---------------------------------------------------------------------------

/**
 * Assert the response is configured as edge-cacheable via `Cache-Control`.
 *
 * The worker's public pages emit
 *   `public, s-maxage=<N>, stale-while-revalidate=<M>`
 * via `publicCache()` (`apps/web/app/lib/cache.ts`). The matcher is intentionally
 * substring-based so the assertion does not break when the helper evolves to
 * accept a custom maxAge or when Cloudflare's Cache API emits extra directives.
 *
 * Bare regex `s-maxage=\d+` would also pass `/s-maxage=0/` (no caching) — to
 * keep the assertion tight, the substring check requires both `s-maxage=` AND
 * `stale-while-revalidate=` to appear in the directive.
 */
export function assertCacheable(response: Response): void {
  const cc = header(response.headers, 'Cache-Control');
  expect(cc).toMatch(/s-maxage=\d+/);
  expect(cc).toContain('stale-while-revalidate=');
}

/**
 * Assert the response took the "first-request" path through the worker —
 * i.e. it was NOT served from the edge cache.
 *
 * The worker sets `X-Edge-Cache: MISS` when the response was just written to
 * the edge cache, and `X-Edge-Cache: BYPASS` when the response opted out of
 * edge caching (non-OK status, non-anonymous request, missing `s-maxage`).
 * Both are valid outcomes for a first request from a cold test process.
 *
 * `X-Edge-Cache: HIT` is intentionally NOT in the whitelist: the Node-side
 * polyfilled `CacheStorage` (`apps/web/test/integration/polyfills.ts`) does
 * NOT roundtrip like workerd (E-P1T1-010 / E-P1T1-018). A HIT through this
 * harness would indicate either a polyfill bug or a real regression in
 * `workers/app.ts`'s cache-key derivation — both worth investigating
 * individually, not via this suite.
 */
export function assertEdgeCacheFirstRequest(response: Response): void {
  const value = response.headers.get('X-Edge-Cache');
  expect(
    value === 'MISS' || value === 'BYPASS',
    `[sigma/test/headers] X-Edge-Cache for ${formatUrl(response)} must be MISS or BYPASS on a first request — got ${JSON.stringify(value)}`,
  ).toBe(true);
}