import { configDefaults, defineConfig } from 'vitest/config';
import { testAlias } from './vitest.alias';

// Two projects so the environment is chosen by file type:
//   *.test.ts  → node (pure logic + workers)
//   *.test.tsx → jsdom + jest-dom matchers (React component/hook tests)
// Convention: a component/hook test must be named *.test.tsx. Mis-named *.test.ts, it runs under node and
// fails loudly (no `document`/`render`) — a self-correcting mistake, not a silent pass.
// The golden replay suite (*.golden.test.ts) is isolated to its own task (vitest.golden.config.ts), so the
// node project excludes it here to keep `pnpm test` and `pnpm test:golden` separate.
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
  },
});
