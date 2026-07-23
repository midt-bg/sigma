import { fileURLToPath } from 'node:url';
import { reactRouter } from '@react-router/dev/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Local dev reads the miniflare D1 that `pnpm run import` ships into apps/web/.wrangler/state (the seed of
// ~4.9k authorities / ~190k contracts) — no re-import here. `scripts/ship-domain.mjs` writes that D1.
const persistPath = fileURLToPath(new URL('.wrangler/state', import.meta.url));

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      persistState: { path: persistPath },
      // Vectorize + AI bindings (added with the assistant feature) cannot be emulated by miniflare
      // and would attempt a remote proxy session that requires a Cloudflare login. Disable the
      // remote proxy so local dev stays fully offline; the assistant route falls back to a 503.
      remoteBindings: false,
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
