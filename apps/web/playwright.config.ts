import { defineConfig, devices } from '@playwright/test';

// E2E runs against the Worker served by `react-router dev` (Cloudflare Vite plugin → miniflare) under
// E2E=1: a hermetic D1 (seeded by e2e/global-setup.ts) and a dedicated port that won't clash with a
// running `pnpm dev`. Just run `pnpm test:e2e` — setup, server and teardown are all handled here.
const PORT = 5273;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Assertions target sample-seed structure, not magnitudes — but keep runs deterministic.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  // The dev server compiles routes lazily on first hit (Vite SSR), so the first navigation to a route
  // can be slow; generous timeouts absorb that cold-compile latency without masking real hangs.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // The mobile navigation flow needs a small viewport; it runs under `mobile-chrome`.
      testIgnore: '**/mobile-nav.spec.ts',
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
      testMatch: '**/mobile-nav.spec.ts',
    },
  ],
  webServer: {
    // Runs in this package's dir (apps/web). Assumes the local D1 is already seeded (`pnpm setup`).
    // E2E=1 disables remote bindings (Workers AI / Vectorize) so the server needs no CF login.
    command: 'pnpm dev',
    env: { E2E: '1' },
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
