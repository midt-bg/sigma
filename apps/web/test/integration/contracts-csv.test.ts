// CSV export integration suite — exercises `GET /contracts.csv` through the real
// SSR Worker pipeline (`apps/web/workers/app.ts`) and asserts the documented
// *header contract* plus the *body shape* for both the production and dev-mode
// outcomes.
//
// Two outcomes are possible from a single first-request GET through the worker:
//
//   1. **200 OK** — the `servedCsvExport()` helper serves the unfiltered
//      export bytes via R2 (`apps/web/app/lib/csv-export.ts:responseFromR2Object`).
//      The documented response contract is:
//
//        Content-Type:        text/csv; charset=utf-8
//        Content-Disposition: attachment; filename="sigma-contracts.csv"
//        Cache-Control:       public, max-age=3600
//        X-Edge-Cache:        MISS (first request through `workers/app.ts`)
//        body first bytes:    BOM (\uFEFF) + "id,unp,subject,authority,..."
//                             + "\n" (the header row produced by
//                             `packages/db/src/queries/contracts.ts:streamContractsCsv`).
//
//   2. **500 Internal Server Error** — the documented dev-mode `devalue` 500:
//
//        Body: "Unexpected Server Error\n\nDevalueError: Cannot stringify
//        arbitrary non-POJOs\n..."
//
//      The `servedCsvExport` helper awaits `env.CSV_CACHE.get(key, ...)` which
//      yields an `R2Object | null`. In `mode: 'test'`, `@react-router/dev` runs
//      the loader data through `devalue.stringify` for resource routes that
//      return a `Response`, and `devalue` does not know how to serialise the
//      in-process miniflare `R2Object` shape. In production
//      (`mode: 'production'` + `react-router build`) the resource route returns
//      a `Response` directly and `devalue` is not involved, so this 500 is a
//      dev-mode-only artefact.
//
//      `workers/app.ts` does NOT add `Content-Disposition` / `Cache-Control` /
//      `X-Edge-Cache` to this 500 — those are applied by `servedCsvExport`
//      only on the 200 path. The 500 carries react-router's default
//      `Content-Type: text/plain; charset=utf-8` plus the worker-level base
//      security-header set.
//
// Why this suite is DEFENSIVE rather than asserting one branch exclusively:
//
//   ADR-0002 documents the dev-mode 500 as a deferred scope cut for the
//   streaming CSV end-to-end assertion. The production 200 path is exercised in isolation by
//   `apps/web/app/lib/csv-export.test.ts` (unit-test lane) and
//   `packages/db/src/queries/csv.test.ts` (unit-test lane for the streaming
//   query). This integration suite fills the gap left by the deferred item:
//   it proves that the WORKER actually reaches the CSV route (the request
//   handler runs), that the CSV rate-limit gate does not consume the request
//   on first call, and that the documented header contract is set when the
//   route serves 200. A regression in any of these would surface here before
//   it surfaces as a missing CSV export in production.
//
//   If the test infrastructure migrates to `@cloudflare/vitest-pool-workers`
//   or a pre-built mode that bypasses `devalue`, the dev-mode 500 branch is
//   expected to disappear and this suite will exercise the 200 branch only.
//   The defensive structure makes that migration cheap: only the assertion
//   structure (and the `it.each` matrix) needs to change, not the test
//   surface.
//
// IP selection:
//
//   The CSV rate-limit binding (`CSV_RATE_LIMITER`, 10 req / 60s) is keyed by
//   `CF-Connecting-IP`. `rate-limit.csv.test.ts` exhausts IPs `203.0.113.30`
//   and `198.51.100.7` and calls `__resetSigmaProxyForTesting()` in its
//   `beforeAll` to deterministically reset the binding. This suite uses a
//   DIFFERENT IP (`203.0.113.60`) and makes only ONE request per test, well
//   under the 10-token quota, so no `__resetSigmaProxyForTesting` call is
//   needed.
//
// The proxy is bootstrapped by `./setup.ts` (lazy per-file via `appFetch()`);
// the `caches` polyfill is installed by `./polyfills.ts` (vitest setupFiles,
// declared before this file so the worker module-init can read
// `caches.default`).

import { describe, expect, it } from 'vitest';
import { appFetch } from './setup';
import {
  assertCommonSecurity,
  assertEdgeCacheFirstRequest,
} from './helpers/headers';

const BASE = 'https://sigma.test';
const CSV_PATH = '/contracts.csv';

const EXPECTED_CSV_HEADER = 'id,unp,subject,authority,authority_eik,contractor,contractor_eik,kind,sector_code,procedure,signed_at,value_eur,eu_funded,bids_received';

const DEV_MODE_500_BODY_PREFIX = 'Unexpected Server Error';
const DEV_MODE_500_BODY_TOKEN = 'DevalueError';

function csvRequest(ip: string): Request {
  return new Request(`${BASE}${CSV_PATH}`, {
    headers: { 'CF-Connecting-IP': ip },
  });
}

describe('GET /contracts.csv — header contract + defensive body shape (issue #94 / A5)', () => {
  it('first request: status is 200 OR dev-mode 500 (deferred), and the worker reaches the route', async () => {
    const res = await appFetch(csvRequest('203.0.113.60'));

    // The request must reach the worker. A 4xx other than 500 (e.g. 401, 403,
    // 404, 429) would mean the route or one of its gates regressed in a way
    // the deferred scope cut does not cover. The CSV rate-limit gate
    // (`workers/app.ts:96`) returns 429 only after 10 requests from the same
    // IP within 60s; this test makes one request, so 429 is unexpected here.
    expect(
      res.status === 200 || res.status === 500,
      `[sigma/test/csv] /contracts.csv must return 200 (production path) or 500 (documented dev-mode devalue scope cut) — got ${res.status}. A 4xx other than 500 indicates a route or gate regression.`,
    ).toBe(true);

    // The worker always applies the base security-header set (see
    // `workers/app.ts:hardenResponse` and `apps/web/app/lib/security.ts`).
    // Both the 200 and 500 paths run through `hardenResponse`.
    assertCommonSecurity(res);

    // The edge-cache disposition is deterministic on a first request from a
    // cold worker process: the route does NOT opt into edge caching (its
    // `Cache-Control: public, max-age=3600` carries no `s-maxage` token, so
    // `workers/app.ts:cacheable` evaluates to `false`), so the worker sets
    // `X-Edge-Cache: BYPASS`. We whitelist MISS|BYPASS to tolerate a future
    // change that introduces a per-route s-maxage.
    assertEdgeCacheFirstRequest(res);

    // Inspect the route-specific headers + body shape.
    const body = await res.text();

    if (res.status === 500) {
      // Dev-mode `devalue` 500 (documented scope cut).
      //
      // The body is react-router's dev-mode error envelope (see
      // `node_modules/.pnpm/react-router@7.15.1.../dist/development/index.js`:
      // `returnLastResortErrorResponse` and the `String(error)` interpolation).
      // The exact stack text varies across devalue versions, but the prefix
      // and the token are stable. We assert the prefix + the devalue error
      // class so a future change to react-router's error envelope is flagged
      // here (and the scope cut is re-evaluated).
      expect(
        body.startsWith(DEV_MODE_500_BODY_PREFIX),
        `[sigma/test/csv] dev-mode 500 body must start with "${DEV_MODE_500_BODY_PREFIX}" — got first 200 chars: ${JSON.stringify(body.slice(0, 200))}`,
      ).toBe(true);
      expect(
        body,
        `[sigma/test/csv] dev-mode 500 body must mention the devalue error class — got first 400 chars: ${JSON.stringify(body.slice(0, 400))}`,
      ).toContain(DEV_MODE_500_BODY_TOKEN);

      // The 500 path runs through `workers/app.ts:hardenResponse`, which
      // applies the base security-header set; it does NOT set
      // `Content-Disposition` / `Cache-Control` (those are `servedCsvExport`'s
      // responsibility, on the 200 branch).
      expect(
        res.headers.get('Content-Disposition'),
        '[sigma/test/csv] dev-mode 500 must NOT carry the CSV `Content-Disposition: attachment` header (that is set only on the 200 branch by `servedCsvExport`)',
      ).toBeNull();
      expect(
        res.headers.get('Cache-Control'),
        '[sigma/test/csv] dev-mode 500 must NOT carry the CSV `Cache-Control: public, max-age=3600` header (that is set only on the 200 branch by `servedCsvExport`)',
      ).toBeNull();
    } else {
      // Production-shape 200.
      //
      // The CSV `Content-Type` is `text/csv; charset=utf-8` (set by
      // `apps/web/app/lib/csv-export.ts:CSV_CONTENT_TYPE`). The match is
      // case-insensitive and tolerates a future charset tweak.
      expect(res.headers.get('Content-Type')?.toLowerCase()).toMatch(
        /^text\/csv(?:\s|;|$)/,
      );

      // The CSV `Content-Disposition` is `attachment; filename="sigma-contracts.csv"`.
      const cd = res.headers.get('Content-Disposition');
      expect(cd, '[sigma/test/csv] 200 must carry `Content-Disposition: attachment; filename="sigma-contracts.csv"` — got null').not.toBeNull();
      expect(cd!.toLowerCase()).toContain('attachment');
      expect(cd!.toLowerCase()).toContain('sigma-contracts.csv');

      // The CSV `Cache-Control` is `public, max-age=3600`. Note this is
      // distinct from the edge-cacheable `Cache-Control: public, s-maxage=...`
      // that the HTML routes emit; the CSV route opts into browser caching,
      // not into the Cloudflare edge cache (no `s-maxage`). The worker-level
      // `X-Edge-Cache: BYPASS` reflects this.
      expect(res.headers.get('Cache-Control')).toContain('max-age=');

      // The CSV header row, with BOM stripped (the body starts with
      // `\uFEFF` + the comma-joined column names + `\n`; see
      // `packages/db/src/queries/contracts.ts:streamContractsCsv`).
      const bodyNoBom = body.replace(/^\uFEFF/, '');
      const firstLine = bodyNoBom.split('\n', 1)[0] ?? '';
      expect(
        firstLine,
        `[sigma/test/csv] 200 body first line must equal the documented CSV header row — got first line ${JSON.stringify(firstLine)}; full body first 300 chars: ${JSON.stringify(bodyNoBom.slice(0, 300))}`,
      ).toBe(EXPECTED_CSV_HEADER);
    }
  });

  it('CSV rate-limit gate does NOT trip on a first request from a fresh IP', async () => {
    // Defensive: the CSV rate-limit gate (`workers/app.ts:96`) is the FIRST
    // gate, before the request handler. A regression that moved the gate to
    // e.g. 1 req / 60s would surface here as 429 instead of the expected
    // 200|500 outcome. We use a unique IP (`203.0.113.61`) so the 10-token
    // quota is fresh and the gate cannot be exhausted by a sibling test.
    const res = await appFetch(csvRequest('203.0.113.61'));

    expect(
      res.status,
      '[sigma/test/csv] first request from a fresh IP must NOT be 429 (rate-limit gate regression) — got 429. The CSV rate-limit is 10 req / 60s and this is the first call from this IP.',
    ).not.toBe(429);

    // Also pin the outcome shape so a future change to react-router's dev-mode
    // error envelope is caught here too.
    expect(
      res.status === 200 || res.status === 500,
      `[sigma/test/csv] /contracts.csv must return 200 or 500 on first call from fresh IP — got ${res.status}`,
    ).toBe(true);
  });
});
