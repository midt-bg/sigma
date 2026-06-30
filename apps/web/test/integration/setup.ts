// Per-test fixture for the integration lane. Drivers tests through the real
// Worker pipeline (`apps/web/workers/app.ts`) using the wrangler proxy.
//
// Why this file exists instead of inlining `await import('../app')` in each test:
//   1. The worker module is imported LAZILY. `workers/app.ts:29` reads
//      `caches.default` at module-init, and `caches` is only installed by
//      `./polyfills.ts` (a vitest setupFile, declaration-ordered to run first).
//      A top-level import here would race the polyfill.
//   2. The lazy import is memoised behind a single Promise so concurrent callers
//      (e.g. tests fan-out via Promise.all) await one module evaluation.
//   3. The first call stashes the resolved module on `globalThis.__SIGMA_APP__`
//      so other test files (or the same suite via vitest workers) can reuse it
//      without re-importing.
//   4. The wrangler proxy (env + ctx) is bootstrapped lazily here on the first
//      `appFetch()` call: vitest runs each test file in its own worker thread,
//      so a proxy stashed by `globalSetup` on a single globalThis is NOT visible
//      to every test file. Lazy per-file bootstrap is cheap (one proxy per
//      worker process) and avoids cross-worker cross-talk. The
//      `./global-setup.ts` (when wired in the vitest config) still runs and
//      still seeds the proxy on `globalThis.__SIGMA_PROXY__` — if it happens to
//      be set in this worker process, we reuse it instead of booting twice.

import { readFileSync } from 'node:fs';
import wrangler from 'wrangler';
import { MIG_0000, MIG_0001, WRANGLER_JSONC } from './paths';

type SigmaProxy = Awaited<ReturnType<typeof wrangler.getPlatformProxy>>;

type WorkerApp = {
  default: {
    fetch: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
  };
};

declare global {
  // eslint-disable-next-line no-var
  var __SIGMA_APP__: WorkerApp | undefined;
  // eslint-disable-next-line no-var
  var __SIGMA_PROXY__: SigmaProxy | undefined;
}

let appPromise: Promise<WorkerApp> | null = null;
let proxyPromise: Promise<SigmaProxy> | null = null;

function stripSqlCommentsAndCollapse(raw: string): string[] {
  const stripped = raw
    .split('\n')
    .map((l) => {
      const idx = l.indexOf('--');
      return idx === -1 ? l : l.slice(0, idx).trimEnd();
    })
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  const statements: string[] = [];
  let buf = '';
  let inString = false;
  let stringChar: string | null = null;
  for (const ch of stripped) {
    if (inString) {
      buf += ch;
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
    }
    if (ch === ';') {
      const t = buf.trim();
      if (t) statements.push(t.replace(/\s+/g, ' ').trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) statements.push(buf.trim().replace(/\s+/g, ' '));
  return statements;
}

function buildContractsInsert(n: number): string {
  const rows: string[] = [];
  for (let i = 1; i <= n; i++) {
    const amount = (n - i + 1) * 1000 + i;
    const m = ((i - 1) % 12) + 1;
    const y = 2020 + Math.floor((i - 1) / 12);
    const d = ((i - 1) % 28) + 1;
    const signedAt = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    rows.push(
      `('c:${i}', 't:FIX-1', 'eik:BG000000001', ${amount}, 'BGN', '${signedAt}', 'ok', 'ok', ${amount}, 0)`,
    );
  }
  return `INSERT OR IGNORE INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, value_flag, date_flag, amount_eur, fx_converted) VALUES ${rows.join(', ')}`;
}

const FIXTURE_AUTHORITIES =
  "INSERT OR IGNORE INTO authorities (id, name, bulstat, type) VALUES ('auth:BG000000000', 'Authority Test', 'BG000000000', 'Министерство')";
const FIXTURE_BIDDERS =
  "INSERT OR IGNORE INTO bidders (id, name, bulstat, eik_normalized, eik_valid, is_consortium, kind) VALUES ('eik:BG000000001', 'Bidder Test', 'BG000000001', '0000000001', 1, 0, 'company')";
const FIXTURE_TENDER =
  "INSERT OR IGNORE INTO tenders (id, source_id, title, authority_id, currency, procedure_type) VALUES ('t:FIX-1', 'FIX-1', 'Test tender', 'auth:BG000000000', 'BGN', 'открита')";
const FIXTURE_HOME_TOTALS =
  "INSERT OR IGNORE INTO home_totals (id, contracts, value_eur, authorities, bidders, suspect, refreshed_at) VALUES (1, 30, 1000000.0, 1, 1, 0, datetime('now'))";
const FIXTURE_DATA_FRESHNESS =
  "INSERT OR IGNORE INTO data_freshness (source, refreshed_at) VALUES ('admin', datetime('now'))";
// The sitemap routes for authorities/companies query the derived
// `authority_totals` / `company_totals` tables (not the base tables). Seed one
// row each so the per-type sitemaps have at least one entry to emit.
const FIXTURE_AUTHORITY_TOTALS =
  "INSERT OR IGNORE INTO authority_totals (authority_id, name, spent_eur, contracts, suppliers, avg_eur, eu_eur, first_date, last_date) VALUES ('auth:BG000000000', 'Authority Test', 1000000.0, 30, 1, 33333.33, 0, '2020-01-01', '2022-12-28')";
const FIXTURE_COMPANY_TOTALS =
  "INSERT OR IGNORE INTO company_totals (bidder_id, name, kind, won_eur, contracts, authorities, eu_eur, first_date, last_date) VALUES ('eik:BG000000001', 'Bidder Test', 'company', 1000000.0, 30, 1, 0, '2020-01-01', '2022-12-28')";

async function bootstrapProxy(): Promise<SigmaProxy> {
  // Honour whatever the vitest `globalSetup` set on this worker process, if it ran here.
  const existing = globalThis.__SIGMA_PROXY__;
  if (existing) return existing;

  const proxy = await wrangler.getPlatformProxy({
    configPath: WRANGLER_JSONC,
    persist: false,
    remoteBindings: false,
  });

  for (const s of stripSqlCommentsAndCollapse(readFileSync(MIG_0000, 'utf8'))) {
    await proxy.env.DB.exec(s);
  }
  for (const s of stripSqlCommentsAndCollapse(readFileSync(MIG_0001, 'utf8'))) {
    await proxy.env.DB.exec(s);
  }
  for (const stmt of [
    FIXTURE_AUTHORITIES,
    FIXTURE_BIDDERS,
    FIXTURE_TENDER,
    FIXTURE_HOME_TOTALS,
    FIXTURE_DATA_FRESHNESS,
    FIXTURE_AUTHORITY_TOTALS,
    FIXTURE_COMPANY_TOTALS,
    buildContractsInsert(30),
  ]) {
    await proxy.env.DB.exec(stmt);
  }

  globalThis.__SIGMA_PROXY__ = proxy;
  return proxy;
}

function getProxy(): Promise<SigmaProxy> {
  if (proxyPromise) return proxyPromise;
  proxyPromise = bootstrapProxy();
  return proxyPromise;
}

function loadApp(): Promise<WorkerApp> {
  if (appPromise) return appPromise;
  appPromise = import('../../workers/app').then((mod) => {
    const resolved = mod as unknown as WorkerApp;
    globalThis.__SIGMA_APP__ = resolved;
    return resolved;
  });
  return appPromise;
}

/**
 * Send a `Request` through the real Worker pipeline using the wrangler proxy env.
 *
 * Polyfills MUST have run before this is called — vitest setupFiles guarantee that.
 * The proxy is bootstrapped lazily on the first call (idempotent within a worker process).
 *
 * Concurrent callers share a single worker-module import.
 */
export async function appFetch(request: Request): Promise<Response> {
  const proxy = await getProxy();
  const app = await loadApp();
  return app.default.fetch(request, proxy.env, proxy.ctx);
}

/** Reset the memoised worker import. Test-only escape hatch. */
export function __resetSigmaAppForTesting(): void {
  appPromise = null;
  delete globalThis.__SIGMA_APP__;
}

/** Test-only: synchronously inspect the memoised worker module (if any). */
export function __getSigmaAppForTesting(): WorkerApp | undefined {
  return globalThis.__SIGMA_APP__;
}

/**
 * Dispose the memoised wrangler proxy and clear the bootstrap memo.
 *
 * Test-only escape hatch used by suites that need a known-fresh rate-limiter
 * state (e.g. the CSV rate-limit burst test) — the limiter binding is in-memory
 * miniflare state that survives across `appFetch` calls within a worker
 * process, and a previous test in the same vitest run may have exhausted the
 * IP-key we want to assert against. Disposing the proxy clears all bindings
 * (including the four `*_RATE_LIMITER` ones) so the next `appFetch` call
 * re-bootstraps a fresh proxy with an empty bucket for every IP.
 *
 * Safe to call when no proxy is bootstrapped: it is a no-op in that case.
 * Disposal errors are swallowed — vitest teardown is best-effort.
 */
export async function __resetSigmaProxyForTesting(): Promise<void> {
  if (proxyPromise) {
    try {
      const p = await proxyPromise;
      await p.dispose();
    } catch {
      // Best-effort: vitest teardown is best-effort. The next `getProxy()` call
      // will build a fresh proxy regardless of whether the dispose threw.
    }
  }
  proxyPromise = null;
  delete globalThis.__SIGMA_PROXY__;
}
