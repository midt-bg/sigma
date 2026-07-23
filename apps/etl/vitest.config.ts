/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

// src/index.ts is a Cloudflare Workflow: it imports the workerd built-in 'cloudflare:workers' and
// pulls .sql files in as wrangler Text modules. Recreate both for plain vitest so the suite can
// exercise the real Workflow module graph end to end: load .sql imports as text, and alias the
// built-in to a minimal test stub.
export default defineConfig({
  plugins: [
    {
      name: 'sql-text-module',
      enforce: 'pre',
      load(id) {
        if (id.endsWith('.sql')) {
          return `export default ${JSON.stringify(readFileSync(id, 'utf8'))};`;
        }
        return null;
      },
    },
  ],
  resolve: {
    alias: {
      'cloudflare:workers': resolve(here, 'src/test/cloudflare-workers-stub.ts'),
    },
  },
  // The refresh Workflow test runs the full refresh-slice.sql derive against a real SQLite —
  // generous headroom for loaded CI runners, same rationale as packages/db/vitest.config.ts.
  test: { testTimeout: 120_000 },
});
