import { fileURLToPath } from 'node:url';
import { reactRouter } from '@react-router/dev/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Local dev reads the miniflare D1 that `pnpm run import` ships into apps/web/.wrangler/state (the seed of
// ~4.9k authorities / ~190k contracts) — no re-import here. `scripts/ship-domain.mjs` writes that D1.
// Playwright E2E (#95) runs hermetically under E2E=1: its own D1 persist dir (seeded by
// e2e/seed.mjs, never the developer's dev DB) and its own port. It also runs with no
// Cloudflare credentials — Workers AI + Vectorize have no local emulation, so with remote bindings on
// the dev server forces a remote proxy session that needs a login; the E2E flows never touch the
// assistant, so remote bindings are disabled. Normal `pnpm dev` is unchanged.
const e2e = process.env.E2E === '1';
const persistPath = fileURLToPath(
  new URL(e2e ? '.wrangler/e2e-state' : '.wrangler/state', import.meta.url),
);

export default defineConfig({
  // Unique tag stamped into the bundle at BUILD time — Node evaluates this once per `react-router build`,
  // so every deploy gets a distinct value. The worker prefixes it into the edge-cache key (workers/app.ts)
  // so a fresh deploy rotates every key and orphans the prior deploy's cached entries (no manual purge).
  // It MUST be a build-time value: reading Date.now() in the worker's global scope returns a CONSTANT
  // (Cloudflare pins the clock while building the startup snapshot), so the tag never changed across deploys
  // and stale HTML survived every redeploy until s-maxage expiry.
  define: {
    __SIGMA_DEPLOY_TAG__: JSON.stringify(Date.now().toString(36)),
  },
  plugins: [
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      persistState: { path: persistPath },
      ...(e2e ? { remoteBindings: false } : {}),
    }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    // Bind all interfaces (IPv4 0.0.0.0 + IPv6) so devcontainer/host port-forwarding,
    // which connects over IPv4 127.0.0.1, can reach the server. Defaulting to `localhost`
    // resolves to IPv6 ::1 only on this box, leaving 127.0.0.1 unbound.
    host: true,
    port: e2e ? 5273 : 5173,
  },
});
