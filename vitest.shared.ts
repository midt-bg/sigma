// Shared test-coverage preset (#93). Every test-bearing workspace's
// vitest.config.ts passes its source globs through sharedCoverage() so the
// provider, reporters and output location stay identical across the monorepo —
// scripts/check-coverage.mjs depends on each workspace emitting
// coverage/coverage-summary.json in this exact shape.
import type { ViteUserConfig } from 'vitest/config';

export function sharedCoverage(include: string[]): NonNullable<ViteUserConfig['test']>['coverage'] {
  return {
    provider: 'v8',
    // Explicit include: without it the v8 provider only reports files loaded
    // by tests, so a new untested module would be invisible to the ratchet.
    include,
    exclude: [
      '**/*.test.*',
      '**/*.spec.*',
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.react-router/**',
      // Test data and type-only declarations are not executable code — instrumenting them reports a
      // permanent 0% that drags the workspace total without any coverable statement (e.g. the
      // assistant JSON fixtures). Non-module file types (.json, .md) need no entry: the provider only
      // ever reports files it can instrument as modules, so they never reach the report even when an
      // include glob is a bare directory (verified — removing them moves no workspace's number).
      '**/fixtures/**',
      '**/*.d.ts',
      // Test-support scaffolding: the cloudflare:workers/workflows stubs that
      // apps/etl/vitest.config.ts aliases the real modules to. They exist only to drive the suites, so
      // instrumenting them measures test scaffolding rather than product code. (The SQLite D1 shim
      // used to sit beside them; #331 moved it into packages/test-support, which carries its own
      // coverage entry, so it no longer needs an exclusion here.)
      //
      // Listed file by file, NOT as `**/src/test/**` (review ydimitrof, #254). A directory glob is the
      // one entry on this list that could hide an untested product MODULE rather than an uncoverable
      // file: anything later dropped into src/test/ would leave the coverage denominator silently. With
      // an explicit list, a new file there is counted until someone deliberately adds it here — which is
      // a reviewable act rather than a side effect of its location.
      '**/src/test/cloudflare-workers-stub.ts',
      '**/src/test/cloudflare-workflows-stub.ts',
    ],
    reporter: ['text', 'json-summary'],
    reportsDirectory: './coverage',
  };
}
