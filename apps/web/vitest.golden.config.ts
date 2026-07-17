import { defineConfig } from 'vitest/config';
import { testAlias } from './vitest.alias';

export default defineConfig({
  // Same `~/` and `cloudflare:workers` aliases as vitest.config.ts (via the shared vitest.alias.ts), so a
  // golden replay test — or a module it transitively imports (e.g. the worker entry re-exporting the
  // assistant Durable Objects) — resolves `~/…`/`cloudflare:workers` instead of failing ERR_MODULE_NOT_FOUND.
  resolve: { alias: testAlias },
  test: {
    environment: 'node',
    include: ['app/**/*.golden.test.ts'],
  },
});
