import { defineConfig } from 'vitest/config';
import { sharedCoverage } from '../../vitest.shared';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: sharedCoverage(['src/**']),
  },
});
