import { defineConfig } from 'vitest/config';
import { sharedCoverage } from '../../vitest.shared';

// @sigma/report is the pure, worker-agnostic report pipeline (extracted in #167A T1). Fast in-process
// unit tests, no external processes — it only needs the shared coverage preset so the ratchet
// (scripts/check-coverage.mjs) sees its coverage/coverage-summary.json like every other workspace.
export default defineConfig({
  test: {
    environment: 'node',
    coverage: sharedCoverage(['src/**']),
  },
});
