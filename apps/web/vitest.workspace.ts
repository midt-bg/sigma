// apps/web/vitest.workspace.ts
//
// Multi-project workspace for `apps/web`. Vitest 4 dropped the legacy
// `test.workspace` option and the `--workspace` CLI flag (see
// https://vitest.dev/guide/migration#vitest-4); the supported way to combine
// multiple vitest configurations in one process is `test.projects` inside a
// vitest config file. This file is the single entry point used by
// `pnpm --filter @sigma/web test` and runs both lanes in one `vitest run`
// invocation.
//
// Run from `apps/web/`:
//   vitest run --config vitest.workspace.ts
// Sub-project selection (e.g. just integration):
//   vitest run --config vitest.workspace.ts --project integration
//
// The unit project's name auto-defaults to the package name from
// `apps/web/package.json` (`@sigma/web`); the integration project's name is
// `integration` (set in `vitest.integration.config.ts`).

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      './vitest.config.ts',
      './vitest.integration.config.ts',
    ],
  },
});
