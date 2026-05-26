import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  // Every route SSRs against D1 (even the chrome footer reads home_totals via the root loader), so
  // nothing is prerendered at build time; public pages are edge-cached via Cache-Control instead.
  future: {
    v8_viteEnvironmentApi: true,
  },
} satisfies Config;
