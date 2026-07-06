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
import {
  buildContractsInsert,
  FIXTURE_STATEMENTS,
  stripSqlCommentsAndCollapse,
} from './helpers/fixtures';

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
  for (const stmt of [...FIXTURE_STATEMENTS, buildContractsInsert(30)]) {
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
