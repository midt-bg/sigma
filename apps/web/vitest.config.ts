import { defineConfig } from 'vitest/config';

// Two projects so the environment is chosen by file type:
//   *.test.ts  → node (pure logic + workers)
//   *.test.tsx → jsdom + jest-dom matchers (React component/hook tests)
// Convention: a component/hook test must be named *.test.tsx. Mis-named *.test.ts, it runs under node and
// fails loudly (no `document`/`render`) — a self-correcting mistake, not a silent pass.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['app/**/*.test.ts', 'workers/**/*.test.ts'],
        },
      },
      {
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
