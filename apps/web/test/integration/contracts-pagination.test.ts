// Contracts pagination (issue #87) integration suite — exercises the keyset
// pagination of `/contracts?sort=...` through the real SSR Worker pipeline
// (`apps/web/workers/app.ts`) and asserts:
//
//   1. The first page renders 200 + text/html + the documented base security
//      header set (header contract is shared with `routes.test.ts`).
//   2. The Pagination component renders a `Следваща ›` anchor whose href
//      carries a keyset cursor (`?cursor=after:base64url`) + `page=2` marker.
//      The cursor encodes `(sortValue, id)` of the last row of page 1 (see
//      `packages/db/src/queries/keyset.ts:encodeCursor`).
//   3. Following the next-page anchor (cursor + page=2) renders page 2 with
//      the next 15 fixture contracts (`PAGE_SIZE.contracts = 15`).
//   4. The two pages carry disjoint contract ids — no row from page 1 appears
//      on page 2. This is the regression check for issue #87: a broken
//      keyset (e.g. using OFFSET + 1) would surface as overlapping ids here.
//   5. Across the two pages, `amount_eur` is monotonic in the sort direction:
//        sort=value-desc → non-increasing (largest → smallest)
//        sort=date-desc  → non-decreasing
//      The fixture is constructed so that `amount_eur` decreases with `i`
//      and `signed_at` increases with `i` (see `setup.ts:buildContractsInsert`),
//      so newest-first dates yield smallest-first amounts. Verifying the
//      concatenated sequence is monotonic nails down the keyset pivot: the
//      cursor must encode the LAST row of page 1 (not page 0, not page 2).
//
// Why this file exists separately from `routes.test.ts`:
//   `routes.test.ts` asserts only the *header* contract (status, security
//   headers, content-type, X-Edge-Cache). This file asserts the *pagination
//   mechanic* — the keyset cursor from `Pagination` nextHref decodes to a
//   valid row, the route resolves it, and the result is monotonic in the
//   sort key. A regression in the keyset would not be caught by the header
//   suite.
//
// Each test sets a distinct `CF-Connecting-IP` so the per-IP rate limiters
// (CSV/SEARCH/AGG/ASSISTANT) get an independent bucket. `/contracts` itself
// is NOT under any rate-limit binding (`/contracts.csv` is — see
// `apps/web/wrangler.jsonc`), but the IPs are still distinct so a future
// change does not silently share state with neighbouring suites.
//
// The proxy is bootstrapped by `./setup.ts` (lazy per-file via
// `appFetch()`); the `caches` polyfill is installed by `./polyfills.ts`
// (vitest setupFiles).

import { describe, expect, it } from 'vitest';
import { appFetch } from './setup';
import {
  assertCommonSecurity,
  assertEdgeCacheFirstRequest,
  assertHtmlContentType,
} from './helpers/headers';

const BASE = 'https://sigma.test';

function get(path: string, ip: string): Promise<Response> {
  return appFetch(new Request(`${BASE}${path}`, { headers: { 'CF-Connecting-IP': ip } }));
}

/**
 * Pull the `Следваща ›` anchor's query string out of the rendered HTML.
 *
 * The Pagination component renders the next link as
 *   <a rel="next"
 *      href="/contracts?sort=value-desc&amp;cursor=after%3Abase64data&amp;page=2"
 *      data-discover="true">Следваща ›</a>
 *
 * Two encodings to normalise:
 *   - React escapes `&` to `&amp;` inside attribute values.
 *   - The cursor value uses `%3A` for the `:` separator; URLSearchParams
 *     decodes that automatically when we re-parse the query string.
 *   - The href is ABSOLUTE (`/contracts?…`), so we extract the query string
 *     starting at `?` rather than the whole path.
 *
 * The attribute order between `rel` and `href` is not guaranteed (React may
 * re-order props in the SSR string), so the regex matches the anchor tag
 * and inspects both attributes from the captured tag substring.
 */
function extractNextQuery(body: string): URLSearchParams | null {
  const anchorMatch = body.match(/<a\b[^>]*rel="next"[^>]*>[^<]*Следваща/i);
  if (!anchorMatch) return null;
  const anchor = anchorMatch[0];
  const hrefMatch = anchor.match(/href="([^"]*)"/);
  if (!hrefMatch) return null;
  const decoded = hrefMatch[1].replace(/&amp;/g, '&');
  const qIdx = decoded.indexOf('?');
  if (qIdx < 0) return null;
  return new URLSearchParams(decoded.slice(qIdx + 1));
}

/**
 * All contract ids rendered as title links in the contracts table.
 *
 * Each row's title link is `<a class="title" href="/contracts/1">…</a>` —
 * React Router's Link uses the SLUG (the route param), not the raw `c:N`
 * internal id. So the regex matches `/contracts/<digits>` and returns the
 * rendered slug (e.g., `"1"`).
 */
function extractContractSlugs(body: string): string[] {
  const matches = body.matchAll(/href="\/contracts\/(\d+)(?:"|\/)/g);
  return Array.from(matches, (m) => m[1]);
}

/**
 * All `amount_eur` values rendered in the money column of the contracts table.
 *
 * Each row's money cell is rendered as
 *   <td class="money" data-label="Стойност (€)">30 хил.</td>
 * `moneyBare()` abbreviates Bulgarian magnitudes (хил./млн./млрд.); for the
 * 30-row fixture (amounts 1030–30001), every row renders as `N хил.`. The
 * regex matches the integer prefix and `хил.`/`млн.`/`млрд.` suffix. The
 * integer prefix is sufficient for the monotonic check below — the actual
 * amount follows the same order as the abbreviated magnitude for the
 * fixture values, and a future fixture change that crosses a magnitude
 * boundary (`999 хил.` → `1 млн.`) would surface as a sorted-bucket
 * assertion failure.
 */
function extractAmountAbbreviations(body: string): number[] {
  const cells = body.matchAll(
    /data-label="Стойност \(€\)">\s*(\d+(?:[,.]\d+)?)\s*(?:хил|млн|млрд)/g,
  );
  return Array.from(cells, (m) => Number(m[1].replace(',', '.')));
}

function expectMonotonicDescending(amounts: number[], label: string): void {
  for (let i = 1; i < amounts.length; i++) {
    expect(
      amounts[i - 1],
      `[sigma/test/pagination] amount_eur must be non-increasing at row ${i} (${label}) — got previous=${amounts[i - 1]}, current=${amounts[i]}, full sequence=${JSON.stringify(amounts)}`,
    ).toBeGreaterThanOrEqual(amounts[i]);
  }
}

function expectMonotonicAscending(amounts: number[], label: string): void {
  for (let i = 1; i < amounts.length; i++) {
    expect(
      amounts[i - 1],
      `[sigma/test/pagination] amount_eur must be non-decreasing at row ${i} (${label}) — got previous=${amounts[i - 1]}, current=${amounts[i]}, full sequence=${JSON.stringify(amounts)}`,
    ).toBeLessThanOrEqual(amounts[i]);
  }
}

/**
 * Compose the second-page URL: keep the original `sort` (and any other
 * top-level query params) and merge in the cursor + page from `nextQuery`.
 * The cursor + page take precedence so we cannot accidentally follow a stale
 * `page` value if the test requester happened to set one.
 */
function buildPage2Url(basePath: string, baseSearch: URLSearchParams, nextQuery: URLSearchParams): string {
  const merged = new URLSearchParams(baseSearch);
  for (const [k, v] of nextQuery) merged.set(k, v);
  const s = merged.toString();
  return `${basePath}${s ? `?${s}` : ''}`;
}

describe('contracts pagination — keyset cursor regression (issue #87)', () => {
  it('GET /contracts?sort=value-desc&page=1 — first page renders + emits a cursor next-anchor', async () => {
    const res = await get('/contracts?sort=value-desc&page=1', '203.0.113.50');
    expect(res.status).toBe(200);
    assertHtmlContentType(res);
    assertCommonSecurity(res);
    assertEdgeCacheFirstRequest(res);

    const body = await res.text();

    // The fixture seeds 30 contracts and PAGE_SIZE.contracts is 15, so the
    // first page must render exactly 15 rows.
    const slugs = extractContractSlugs(body);
    expect(
      slugs,
      `[sigma/test/pagination] page 1 must render 15 rows from the 30-row fixture — got ${slugs.length}: ${JSON.stringify(slugs)}`,
    ).toHaveLength(15);

    // The Pagination component must emit a next anchor carrying the keyset
    // cursor (a `?cursor=after:` base64url payload) + a `page=2` marker.
    const nextQuery = extractNextQuery(body);
    expect(
      nextQuery,
      '[sigma/test/pagination] page 1 must emit a `Следваща ›` anchor with a ?cursor=... href',
    ).not.toBeNull();
    const cursor = nextQuery!.get('cursor');
    expect(
      cursor,
      `[sigma/test/pagination] the next anchor's ?cursor must be a non-empty 'after:<base64url>' payload — got ${JSON.stringify(cursor)}`,
    ).toMatch(/^after:/);
    expect(
      nextQuery!.get('page'),
      `[sigma/test/pagination] the next anchor must carry page=2 — got ${JSON.stringify(nextQuery!.get('page'))}`,
    ).toBe('2');
  });

  it('GET /contracts?sort=value-desc&cursor=…&page=2 — second page renders, is disjoint from page 1, monotone amount_eur', async () => {
    // Page 1 → extract the next-anchor cursor.
    const first = await get('/contracts?sort=value-desc&page=1', '203.0.113.51');
    expect(first.status).toBe(200);
    const firstBody = await first.text();
    const firstSlugs = extractContractSlugs(firstBody);
    expect(firstSlugs).toHaveLength(15);

    const firstAmounts = extractAmountAbbreviations(firstBody);
    expect(
      firstAmounts,
      `[sigma/test/pagination] page 1 must render 15 amount_eur values — got ${firstAmounts.length}: ${JSON.stringify(firstAmounts)}`,
    ).toHaveLength(15);

    const nextQuery = extractNextQuery(firstBody);
    expect(nextQuery, '[sigma/test/pagination] page 1 must carry a next cursor').not.toBeNull();

    // Page 2 → follow the cursor + page=2 (splice into the original sort URL).
    const page2Url = buildPage2Url(
      '/contracts',
      new URLSearchParams({ sort: 'value-desc' }),
      nextQuery!,
    );
    const second = await get(page2Url, '203.0.113.52');
    expect(second.status).toBe(200);
    assertHtmlContentType(second);
    assertCommonSecurity(second);
    assertEdgeCacheFirstRequest(second);

    const secondBody = await second.text();

    const secondSlugs = extractContractSlugs(secondBody);
    expect(
      secondSlugs,
      `[sigma/test/pagination] page 2 must render 15 rows (fixture has 30 contracts, pageSize=15) — got ${secondSlugs.length}: ${JSON.stringify(secondSlugs)}`,
    ).toHaveLength(15);

    // Disjointness: every page-2 slug must NOT appear on page 1. This is the
    // direct regression check for issue #87 — a broken keyset (e.g. using
    // OFFSET + 1) would surface here as overlapping slugs.
    const firstSet = new Set(firstSlugs);
    for (const slug of secondSlugs) {
      expect(
        firstSet.has(slug),
        `[sigma/test/pagination] page 2 slug ${slug} must not appear on page 1 — page 1 slugs=${JSON.stringify(firstSlugs)}; page 2 slugs=${JSON.stringify(secondSlugs)}`,
      ).toBe(false);
    }

    const secondAmounts = extractAmountAbbreviations(secondBody);
    expect(secondAmounts).toHaveLength(15);

    // value-desc → the concatenated sequence must be non-increasing. The
    // pivot (last row of page 1 → first row of page 2) is the most fragile
    // part of the keyset: it depends on the cursor encoding exactly the
    // sortValue + id of the last row of page 1.
    expectMonotonicDescending([...firstAmounts, ...secondAmounts], 'value-desc');
  });

  it('GET /contracts?sort=date-desc&page=1 — first page renders + emits a cursor next-anchor', async () => {
    const res = await get('/contracts?sort=date-desc&page=1', '203.0.113.53');
    expect(res.status).toBe(200);
    assertHtmlContentType(res);
    assertCommonSecurity(res);
    assertEdgeCacheFirstRequest(res);

    const body = await res.text();

    const slugs = extractContractSlugs(body);
    expect(
      slugs,
      `[sigma/test/pagination] date-desc page 1 must render 15 rows from the 30-row fixture — got ${slugs.length}: ${JSON.stringify(slugs)}`,
    ).toHaveLength(15);

    const nextQuery = extractNextQuery(body);
    expect(nextQuery, '[sigma/test/pagination] date-desc page 1 must emit a next anchor').not.toBeNull();
    expect(nextQuery!.get('cursor')).toMatch(/^after:/);
    expect(nextQuery!.get('page')).toBe('2');
  });

  it('GET /contracts?sort=date-desc&cursor=…&page=2 — second page is disjoint from page 1, monotone amount_eur', async () => {
    // Page 1 (newest signedAt first).
    const first = await get('/contracts?sort=date-desc&page=1', '203.0.113.54');
    expect(first.status).toBe(200);
    const firstBody = await first.text();
    const firstSlugs = extractContractSlugs(firstBody);
    expect(firstSlugs).toHaveLength(15);

    const firstAmounts = extractAmountAbbreviations(firstBody);
    expect(firstAmounts).toHaveLength(15);

    const nextQuery = extractNextQuery(firstBody);
    expect(nextQuery).not.toBeNull();

    // Page 2 (the older half of the fixture).
    const page2Url = buildPage2Url(
      '/contracts',
      new URLSearchParams({ sort: 'date-desc' }),
      nextQuery!,
    );
    const second = await get(page2Url, '203.0.113.55');
    expect(second.status).toBe(200);
    assertHtmlContentType(second);
    assertCommonSecurity(second);
    assertEdgeCacheFirstRequest(second);

    const secondBody = await second.text();
    const secondSlugs = extractContractSlugs(secondBody);
    expect(secondSlugs).toHaveLength(15);

    // Disjointness.
    const firstSet = new Set(firstSlugs);
    for (const slug of secondSlugs) {
      expect(
        firstSet.has(slug),
        `[sigma/test/pagination] date-desc page 2 slug ${slug} must not appear on page 1 — page 1 slugs=${JSON.stringify(firstSlugs)}; page 2 slugs=${JSON.stringify(secondSlugs)}`,
      ).toBe(false);
    }

    const secondAmounts = extractAmountAbbreviations(secondBody);
    expect(secondAmounts).toHaveLength(15);

    // date-desc → the fixture is constructed so that `amount_eur` is inversely
    // correlated with `signed_at`: the formula `amount = (30 - i + 1) * 1000 + i`
    // decreases as `i` grows, while `signed_at` (built from `(i - 1) % 12`,
    // `2020 + floor((i - 1) / 12)`, `(i - 1) % 28`) strictly increases with `i`.
    // So newest-first dates yield smallest-first amounts — the concatenated
    // sequence is non-decreasing.
    expectMonotonicAscending([...firstAmounts, ...secondAmounts], 'date-desc');
  });
});