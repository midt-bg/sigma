// CSV export rate-limit burst test — exercises the real CSV rate-limiter binding
// (`CSV_RATE_LIMITER`, configured at 10 requests per 60s in
// `apps/web/wrangler.jsonc`) through the real SSR Worker pipeline
// (`apps/web/workers/app.ts`) and asserts the documented 11-call burst contract.
//
// Two serial tests inside a single describe (`concurrent: false`):
//
//   1. **11× burst from `203.0.113.30`** — fire 11 GET /contracts.csv requests
//      sharing the same `CF-Connecting-IP`. The CSV rate-limit check is the
//      FIRST gate in `workers/app.ts:96` (before the request handler), so the
//      11th call is rejected with:
//          status              = 429
//          Retry-After         = 60
//          Content-Type        = text/plain; charset=utf-8
//          body                = "Too many CSV export requests"
//      This body literal is produced by `rateLimitExceededResponse()` in
//      `apps/web/workers/rate-limit.ts` and the per-route message is passed in
//      by `rateLimitCsvExport()` in `apps/web/workers/csv-rate-limit.ts`.
//
//      Calls 1-10 may surface the documented dev-mode `devalue` 500 from
//      `/contracts.csv` — the R2 multipart-upload path yields `R2Object`-bearing promises that
//      `@react-router/dev` in `mode: 'test'` cannot serialise). The rate-limit
//      check fires before the request handler runs, so the 11th call's 429 is
//      independent of any prior handler-side failure. The loop tolerates
//      handler errors on calls 1-10 and asserts only the 11th call's contract.
//
//   2. **Per-IP isolation from `198.51.100.7`** — fire 11 GET /contracts.csv
//      requests from a DIFFERENT `CF-Connecting-IP`. The assertion is twofold:
//
//        a. The FIRST call must NOT be 429 — the new IP has a fresh 10-token
//           bucket that was not contaminated by the first test's 203.0.113.30
//           exhaustion. A leaked-bucket bug would surface here: the second
//           test's first call would be 429 if the rate-limit storage were a
//           single global counter rather than a per-IP-key map.
//
//        b. The 11th call IS 429 — same 429 contract as the first test,
//           proving the per-IP bucket has the same 10-token quota.
//
//   3. **Why `beforeAll` disposes the proxy** — the `*_RATE_LIMITER` bindings
//      are in-memory miniflare state that persists across `appFetch` calls
//      inside a single vitest worker process. A prior test in the same run
//      (e.g. any test that bursts the CSV limiter from a known IP) could
//      leave the bucket empty before this file even runs.
//      `__resetSigmaProxyForTesting()` disposes the memoised proxy so the
//      next `appFetch` call rebuilds a fresh one with an empty limiter. The
//      fixture (migrations + INSERT OR IGNORE rows) is reapplied in
//      `bootstrapProxy()`, so the D1 is also reset to a known state.
//
//      This also matches the spec's "fresh describe after disposing the proxy"
//      language literally: the burst test runs against a known-fresh
//      limiter/proxy state, and the per-IP-isolation test then exercises a
//      DIFFERENT IP within the same fresh proxy to prove the bucket keying is
//      per-IP.
//
// The proxy bootstrap + D1 seeding live in `bootstrapProxy()` (see
// `./setup.ts`); the `caches` polyfill is installed by `./polyfills.ts`
// (vitest setupFiles, declared before this file so the worker module-init
// can read `caches.default`).

import { beforeAll, describe, expect, it } from 'vitest';
import { appFetch, __resetSigmaProxyForTesting } from './setup';

const BASE = 'https://sigma.test';
const CSV_PATH = '/contracts.csv';
const DEV_MODE_500_BODY_PREFIX = 'Unexpected Server Error';
const DEV_MODE_500_BODY_TOKEN = 'DevalueError';

function csvRequest(ip: string): Request {
  return new Request(`${BASE}${CSV_PATH}`, {
    headers: { 'CF-Connecting-IP': ip },
  });
}

async function assertCsvNonRateLimitedResponse(res: Response, label: string): Promise<void> {
  const body = await res.text();

  if (res.status === 200) return;

  if (res.status === 500) {
    expect(
      body.startsWith(DEV_MODE_500_BODY_PREFIX),
      `[sigma/test/rate-limit] ${label} dev-mode 500 body must start with "${DEV_MODE_500_BODY_PREFIX}" — got first 200 chars: ${JSON.stringify(body.slice(0, 200))}`,
    ).toBe(true);
    expect(
      body,
      `[sigma/test/rate-limit] ${label} dev-mode 500 body must mention the devalue error class — got first 400 chars: ${JSON.stringify(body.slice(0, 400))}`,
    ).toContain(DEV_MODE_500_BODY_TOKEN);
    return;
  }

  expect.fail(
    `[sigma/test/rate-limit] ${label} must return 200 or the documented dev-mode 500 before the rate-limit bucket is exhausted; got ${res.status}`,
  );
}

describe('CSV export rate limit — 11× burst (issue #94 / A3)', { concurrent: false }, () => {
  beforeAll(async () => {
    // The CSV rate-limit binding is in-memory miniflare state that persists
    // across `appFetch` calls inside one vitest worker process. A previous
    // test file in this run may have already consumed the 203.0.113.30 key.
    // Reset to a known-fresh state so the burst assertion is deterministic.
    // The fixture (migrations + INSERT OR IGNORE rows) is reapplied inside
    // `bootstrapProxy()` on the next `appFetch` call.
    await __resetSigmaProxyForTesting();
  });

  it('11th CSV export from 203.0.113.30 → 429 + Retry-After: 60 + "Too many CSV export requests"', async () => {
    let eleventh: Response | null = null;

    for (let i = 1; i <= 11; i++) {
      const res = await appFetch(csvRequest('203.0.113.30'));
      if (i === 11) {
        eleventh = res;
      } else {
        await assertCsvNonRateLimitedResponse(res, `call ${i} from 203.0.113.30`);
      }
    }

    expect(eleventh, '[sigma/test/rate-limit] expected 11th response to be captured').not.toBeNull();
    expect(eleventh!.status).toBe(429);
    expect(eleventh!.headers.get('Retry-After')).toBe('60');
    expect(eleventh!.headers.get('Content-Type')).toContain('text/plain');
    const body = await eleventh!.text();
    expect(body).toBe('Too many CSV export requests');
  });

  it('per-IP isolation: 11× from 198.51.100.7 → first is not 429 + 11th is 429 (independent bucket)', async () => {
    // The second test uses a different `CF-Connecting-IP` against the same
    // (fresh) proxy. The first call from the new IP must NOT be 429 — its
    // 10-token bucket is independent of the 203.0.113.30 exhaustion in the
    // previous test, proving the rate-limit storage is keyed per-IP. The
    // 11th call from the new IP trips ITS OWN 10-token bucket with the
    // same 429 contract as test 1.
    let firstResponse: Response | null = null;
    let eleventh: Response | null = null;

    for (let i = 1; i <= 11; i++) {
      const res = await appFetch(csvRequest('198.51.100.7'));
      if (i === 1) {
        firstResponse = res;
        await assertCsvNonRateLimitedResponse(res, 'first call from fresh IP 198.51.100.7');
      } else if (i === 11) {
        eleventh = res;
      } else {
        await assertCsvNonRateLimitedResponse(res, `call ${i} from 198.51.100.7`);
      }
    }

    expect(firstResponse, '[sigma/test/rate-limit] expected first response to be captured').not.toBeNull();

    expect(eleventh, '[sigma/test/rate-limit] expected 11th response to be captured').not.toBeNull();
    expect(eleventh!.status).toBe(429);
    expect(eleventh!.headers.get('Retry-After')).toBe('60');
    expect(eleventh!.headers.get('Content-Type')).toContain('text/plain');
    const body = await eleventh!.text();
    expect(body).toBe('Too many CSV export requests');
  });
});
