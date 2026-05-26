import { fileURLToPath } from "node:url";
import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Local dev reads the SAME miniflare D1 that `pnpm import` populates under apps/api (the seed of 4.9k
// authorities / 190k contracts). Both apps bind `sigma` with the same database_id, so pointing this
// app's persisted state at apps/api/.wrangler/state opens the identical D1 file — no re-import here.
const persistPath = fileURLToPath(new URL("../api/.wrangler/state", import.meta.url));

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      persistState: { path: persistPath },
    }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: 5173,
  },
});
