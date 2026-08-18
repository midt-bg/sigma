import { configDefaults, defineConfig } from 'vitest/config';
import { testAlias } from './vitest.alias';
import { sharedCoverage } from '../../vitest.shared';

// Two projects so the environment is chosen by file type:
//   *.test.ts  → node (pure logic + workers)
//   *.test.tsx → jsdom + jest-dom matchers (React component/hook tests)
// Convention: a component/hook test must be named *.test.tsx. Mis-named *.test.ts, it runs under node and
// fails loudly (no `document`/`render`) — a self-correcting mistake, not a silent pass.
// The golden replay suite (*.golden.test.ts) is isolated to its own task (vitest.golden.config.ts), so the
// node project excludes it here to keep `pnpm test` and `pnpm test:golden` separate.
//
// Coverage exclude extends the shared preset: the assistant ships a large data corpus under app/** —
// the golden replay fixtures (app/lib/assistant/golden/fixtures/*.json) and R2 report fixtures — which
// are pure data, not executable source. The v8 `include: ['app/**']` would otherwise count every one at
// 0% lines and sink the coverage ratchet (upstream's tree has no such corpus, so its shared preset never
// needed the filter). JSON has no lines/branches/functions to execute, so excluding it is correct, not a
// coverage dodge; real untested source (e.g. components) stays counted.
const webCoverage = sharedCoverage(['app/**', 'workers/**']);

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: testAlias },
        test: {
          name: 'node',
          environment: 'node',
          include: ['app/**/*.test.ts', 'workers/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'app/**/*.golden.test.ts'],
        },
      },
      {
        resolve: { alias: testAlias },
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['app/**/*.test.tsx'],
          setupFiles: ['./app/vitest.setup.ts'],
        },
      },
    ],
    coverage: { ...webCoverage, exclude: [...(webCoverage?.exclude ?? []), '**/*.json'] },
  },
});
