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
      // assistant JSON fixtures).
      '**/fixtures/**',
      '**/*.json',
      '**/*.md',
      '**/*.d.ts',
    ],
    reporter: ['text', 'json-summary'],
    reportsDirectory: './coverage',
  };
}
