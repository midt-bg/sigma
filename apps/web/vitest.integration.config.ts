// Vitest workspace for the integration lane. Run with `vitest run --config vitest.integration.config.ts`.
// The unit project lives in vitest.config.ts (untouched). This file extends the root
// vitest.config.ts and adds the integration project on top, OR you can run it standalone
// and use projects to inherit `extends: true`.
//
// Wired plugins: reactRouter() — resolves virtual:react-router/server-build.
// Wired setupFiles: ./test/integration/polyfills.ts — installs workerd `caches` polyfill.
// Wired globalSetup: ./test/integration/global-setup.ts — boots proxy + applies migrations
//                                                           + seeds fixture + disposes.
import { defineConfig } from 'vitest/config';
import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);

function resolveOtelEsmRoot(): string {
  try {
    return path.join(path.dirname(require.resolve('@opentelemetry/api/package.json')), 'build/esm');
  } catch {
    const pnpmStore = path.join(repoRoot, 'node_modules/.pnpm');
    const packageDir = readdirSync(pnpmStore)
      .filter((entry) => entry.startsWith('@opentelemetry+api@'))
      .map((entry) => path.join(pnpmStore, entry, 'node_modules/@opentelemetry/api'))
      .find((candidate) => existsSync(path.join(candidate, 'build/esm')));

    if (!packageDir) {
      throw new Error('Unable to resolve @opentelemetry/api build/esm directory for integration tests');
    }

    return path.join(packageDir, 'build/esm');
  }
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
  server: {
    deps: {
      inline: [/^@opentelemetry\/api/, /^@ai-sdk/, /^ai/, /^@sigma\//],
    },
  },
  test: {
    name: 'integration',
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
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
    globalSetup: ['./test/integration/global-setup.ts'],
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
