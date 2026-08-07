// Vitest workspace for the integration lane. Run with `vitest run --config vitest.integration.config.ts`.
// The unit project lives in vitest.config.ts (untouched). This file extends the root
// vitest.config.ts and adds the integration project on top, OR you can run it standalone
// and use projects to inherit `extends: true`.
//
// Wired plugins: reactRouter() — resolves virtual:react-router/server-build.
// Wired setupFiles: ./test/integration/polyfills.ts — installs workerd `caches` polyfill.
//
// No `globalSetup`: each test file bootstraps its own wrangler proxy lazily via
// `./test/integration/setup.ts:appFetch()` (see that file for why a single globalSetup proxy is
// not visible to vitest's per-file worker processes). Wiring a globalSetup that seeds a proxy no
// test reads was pure overhead, so it was removed (PR #177 review T-003).
import { defineConfig } from 'vitest/config';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);

const OTEL_STORE_ENTRY_PREFIX = '@opentelemetry+api@';

/**
 * Pure helper: given the raw `.pnpm/` directory entries and the version `@opentelemetry/api` resolves
 * to in the app's dependency tree, return the store entry name that matches that version — falling
 * back to the highest semver present when no exact match exists. Pure (no FS) so it is unit-testable.
 *
 * Why prefer the exact app version over "highest semver": if pnpm ever hoists two versions of
 * `@opentelemetry/api`, the old `.find()` picked the FIRST entry after a descending sort — which can
 * differ from the version the app actually imports, silently aliasing the wrong build. Matching the
 * resolved version removes that nondeterminism (PR #177 review T-001).
 */
export function pickOtelStoreEntry(
  entries: readonly string[],
  appVersion: string | null,
): string | null {
  const versions = entries
    .filter((e) => e.startsWith(OTEL_STORE_ENTRY_PREFIX))
    .map((e) => ({ entry: e, version: e.slice(OTEL_STORE_ENTRY_PREFIX.length) }));
  if (versions.length === 0) return null;

  // Exact match on the semver core (ignoring the `_…` peer-dep hash) wins — that is the version the
  // app imports, so its build/esm is the correct alias target.
  if (appVersion) {
    const exact = versions.find((v) => compareSemverDesc(v.version, appVersion) === 0);
    if (exact) return exact.entry;
  }
  // Fallback: highest semver core (deterministic; same input → same output).
  return [...versions].sort((a, b) => compareSemverDesc(a.version, b.version))[0]!.entry;
}

function resolveOtelEsmRoot(): string {
  try {
    return path.join(path.dirname(require.resolve('@opentelemetry/api/package.json')), 'build/esm');
  } catch {
    // Fallback: when `require.resolve` fails (e.g. pnpm hoisting put the package
    // under a non-default path), walk the pnpm store. Match the version the app depends on first
    // (read from apps/web/package.json), falling back to the highest semver present — both
    // deterministic (PR #177 review T-001).
    const pnpmStore = path.join(repoRoot, 'node_modules/.pnpm');
    const entries = readdirSync(pnpmStore);
    const appVersion = readOtelAppVersion();
    const entry = pickOtelStoreEntry(entries, appVersion);
    if (!entry) {
      throw new Error(
        'Unable to resolve @opentelemetry/api build/esm directory for integration tests',
      );
    }
    const candidate = path.join(pnpmStore, entry, 'node_modules/@opentelemetry/api');
    if (!existsSync(path.join(candidate, 'build/esm'))) {
      throw new Error(`Resolved @opentelemetry/api store entry has no build/esm: ${entry}`);
    }
    return path.join(candidate, 'build/esm');
  }
}

/** Read the `@opentelemetry/api` version the app declares, or null if absent/unreadable. */
function readOtelAppVersion(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('./package.json') as { dependencies?: Record<string, string> };
    const spec = pkg.dependencies?.['@opentelemetry/api'];
    if (!spec) return null;
    // Strip leading semver range operators (^/~/>=/exact) to get a comparable core.
    const core =
      spec
        .replace(/^[~^>=<\s]+/, '')
        .split(' ')
        .pop() ?? '';
    return core || null;
  } catch {
    return null;
  }
}

/**
 * Compare two pnpm-store directory version segments, descending. The entries under
 * `node_modules/.pnpm/` are keyed as `<name>@<version>` where `<version>` is either plain semver
 * (`@opentelemetry+api@1.9.1`) or semver followed by a `_`-delimited peer-dep hash
 * (`vitest@4.1.7_@opentelemetry+api@1.9.1_@types+node@...`). `core()` strips the `_…` peer-dep
 * tail before comparing the numeric semver core so the sort is deterministic regardless of which
 * flavour a given entry uses (PR #177 review T-007: the old comment described a `(hash)` parens
 * flavour that does not occur in store dir names, only in resolved package.json deps).
 */
function compareSemverDesc(a: string, b: string): number {
  const core = (s: string) => s.replace(/_.*$/, '');
  const [aMajor, aMinor, aPatch] = core(a)
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  const [bMajor, bMinor, bPatch] = core(b)
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  if (aMajor !== bMajor) return bMajor - aMajor;
  if (aMinor !== bMinor) return bMinor - aMinor;
  return bPatch - aPatch;
}

const otelEsmRoot = resolveOtelEsmRoot();

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    alias: [
      // Workaround for @opentelemetry/api@1.9.1 — its ESM build uses extension-less
      // relative imports (`./baggage/utils`) which Node 24's strict ESM loader rejects.
      // Vite resolves the alias through its own resolver; vite-node uses it too.
      {
        find: /^@opentelemetry\/api\/build\/esm\/baggage\/utils$/,
        replacement: path.join(otelEsmRoot, 'baggage/utils.js'),
      },
      {
        find: /^@opentelemetry\/api\/build\/esm\/trace\/internal\/utils$/,
        replacement: path.join(otelEsmRoot, 'trace/internal/utils.js'),
      },
    ],
  },
  optimizeDeps: {
    include: ['@opentelemetry/api', 'ai', '@ai-sdk/openai'],
  },
  ssr: {
    noExternal: ['@opentelemetry/api', 'ai', '@ai-sdk/openai'],
  },
  // Note: there is intentionally NO top-level `server.deps.inline`. `vitest run` reads
  // `test.server.deps.inline` (below); the top-level `server` block configures Vite's dev
  // server, which is not involved when running tests. Defining the same list in both places
  // was duplicated config that could drift (PR #177 review T-005, "NO CODE DUPLICATION").
  test: {
    name: 'integration',
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    // `include` is already scoped to `test/integration/**`, so the unit tests under `app/**` and
    // `workers/**` can never be picked up here. The exclude list is kept as a defensive safety net:
    // if a future `include` widening (or a glob accident) ever let a worker test slip in, this list
    // blocks it from running twice — once in the unit lane and once here. Without the comment it
    // read as dead config (PR #177 review T-006, "NO DEAD CODE").
    exclude: [
      'app/**/*.test.ts',
      'workers/csv-rate-limit.test.ts',
      'workers/csp.test.ts',
      'workers/rate-limit.test.ts',
      'workers/cache-key.test.ts',
      'workers/app.cache.test.ts',
      'workers/aggregation-rate-limit.test.ts',
      'workers/assistant-rate-limit.test.ts',
      'workers/search-rate-limit.test.ts',
      'workers/request-log.test.ts',
      'workers/http.test.ts',
    ],
    setupFiles: ['./test/integration/polyfills.ts'],
    server: {
      deps: {
        inline: [/^@opentelemetry\/api/, /^@ai-sdk/, /^ai/, /^@sigma\//],
      },
    },
    // Try hard: tell vitest to bundle all of these.
    deps: {
      optimizer: {
        web: { enabled: true },
        ssr: { enabled: true },
      },
      interopDefault: true,
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
