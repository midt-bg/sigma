#!/usr/bin/env node
// Wrangler config renderer. The committed apps/*/wrangler.{toml,jsonc} hold safe zero-UUID
// dummies for the resource IDs (`database_id` for D1, `id` for KV) so `wrangler dev` and the
// vite cloudflare plugin parse cleanly and miniflare keys local state by stable values.
// `wrangler deploy` needs the real IDs — this script substitutes them from env vars and
// writes a sibling `wrangler.deploy.<ext>` that the package `deploy` script passes via
// `--config`. Result: zero production identifiers in the repo, so the same source supports
// another deploy in another Cloudflare account by setting different env vars.
//
// usage: node scripts/wrangler-render.mjs <path/to/wrangler.toml|jsonc>

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

// Sentinel <- env var. The sentinels appear verbatim in the committed wrangler.* files;
// the values come from the environment at deploy time. Add a row to extend (e.g. a future KV).
const SENTINELS = {
  '00000000-0000-0000-0000-000000000000': 'SIGMA_D1_ID',          // D1 database_id (UUID v4 shape)
};

const input = process.argv[2];
if (!input) {
  console.error('usage: wrangler-render.mjs <wrangler.toml|wrangler.jsonc>');
  process.exit(2);
}

const src = readFileSync(input, 'utf8');
let out = src;
const missing = [];
for (const [sentinel, envVar] of Object.entries(SENTINELS)) {
  if (!src.includes(sentinel)) continue;
  const real = process.env[envVar];
  if (!real) {
    missing.push(envVar);
    continue;
  }
  out = out.split(sentinel).join(real);
}

if (missing.length) {
  console.error(`✘ wrangler-render: ${input} needs ${missing.join(', ')}`);
  console.error('  set them in .env.local (then: set -a; source .env.local; set +a) or as repo secrets for CI.');
  process.exit(1);
}

const outPath = join(dirname(input), basename(input).replace(/^wrangler\./, 'wrangler.deploy.'));
writeFileSync(outPath, out);
console.log(`wrangler-render: ${input} → ${outPath}`);
