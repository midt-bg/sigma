import { configDefaults, defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

// Mirror the tsconfig `~/*` → `./app/*` path mapping so `~/` imports resolve in tests.
const tildaAlias = { '~': fileURLToPath(new URL('./app', import.meta.url)) };

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
        resolve: { alias: tildaAlias },
        test: {
          name: 'node',
          environment: 'node',
          include: ['app/**/*.test.ts', 'workers/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'app/**/*.golden.test.ts'],
        },
      },
      {
        resolve: { alias: tildaAlias },
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
