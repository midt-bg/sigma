import { fileURLToPath, URL } from 'node:url';

// Shared test path aliases, imported by BOTH vitest.config.ts and vitest.golden.config.ts so that
// `pnpm test` and `pnpm test:golden` resolve modules identically. Mirrors the tsconfig `~/*` → `./app/*`
// mapping so `~/` imports resolve in tests, and stubs the `cloudflare:workers` runtime module
// (unresolvable in node) so a test importing the worker entry — which re-exports the assistant Durable
// Object classes — can load. Types still come from @cloudflare/workers-types at typecheck; this alias is
// runtime-only. Resolved relative to this file, which sits in apps/web alongside both configs.
export const testAlias = {
  '~': fileURLToPath(new URL('./app', import.meta.url)),
  'cloudflare:workers': fileURLToPath(
    new URL('./test/stubs/cloudflare-workers.ts', import.meta.url),
  ),
};
