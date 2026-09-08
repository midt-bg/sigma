import { fileURLToPath } from 'node:url';
import { reactRouter } from '@react-router/dev/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Local dev reads the miniflare D1 that `pnpm run import` ships into apps/web/.wrangler/state (the seed of
// ~4.9k authorities / ~190k contracts) — no re-import here. `scripts/ship-domain.mjs` writes that D1.
const persistPath = fileURLToPath(new URL('.wrangler/state', import.meta.url));

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
      // `ai` + `vectorize` (wrangler.jsonc) have no local emulation, so the plugin proxies them to the
      // account through a "remote proxy session". Worth knowing what that session is: it POSTs a
      // generated proxy Worker to /accounts/:id/workers/scripts/:name/edge-preview (and can register a
      // workers.dev subdomain). Ephemeral and unrelated to `wrangler deploy`, but it is a write to the
      // account — hence the escape hatch below.
      //
      // Default: on when credentials are present (the assistant works, as in the documented workflow),
      // off when they are not — instead of aborting the whole dev server, which is what used to happen
      // and left `pnpm dev` unusable for anyone without a Cloudflare account. Without the session the
      // two bindings are simply absent and the assistant route returns its existing 503
      // (routes/assistant.chat.tsx); every other page is unaffected.
      //
      // SIGMA_DEV_REMOTE_BINDINGS overrides either way: "0" keeps dev entirely local even with a token
      // exported, "1" forces the attempt.
      remoteBindings:
        process.env.SIGMA_DEV_REMOTE_BINDINGS === '1' ||
        (process.env.SIGMA_DEV_REMOTE_BINDINGS !== '0' &&
          Boolean(process.env.CLOUDFLARE_API_TOKEN)),
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
    port: 5173,
  },
});
