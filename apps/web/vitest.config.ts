import { defineConfig } from 'vitest/config';
import { sharedCoverage } from '../../vitest.shared';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['app/**/*.test.ts', 'app/**/*.test.tsx', 'workers/**/*.test.ts'],
    coverage: sharedCoverage(['app/**', 'workers/**']),
  },
});
