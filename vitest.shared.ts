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
      // Test-support helpers (SQLite D1 shims, cloudflare:workers/workflows stubs) live under src/test/.
      // They exist only to drive the suites — instrumenting them measures test scaffolding, not product
      // code, so they belong with fixtures on the exclude list.
      //
      // This glob is wide on purpose but narrow in contract: src/test/ is for test HELPERS only. Product
      // code placed there would leave the coverage denominator silently, which is the one way this list
      // can hide an untested module rather than an uncoverable file. Review any new src/test/ entry on
      // that basis (review ydimitrof, #254).
      '**/src/test/**',
    ],
    reporter: ['text', 'json-summary'],
    reportsDirectory: './coverage',
  };
}
