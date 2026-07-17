#!/usr/bin/env node
// Create the R2 CSV-export cache bucket the web worker binds (one-time per environment).
// Dry-run by default; pass --apply to actually create it.
//
// Split out of bootstrap.mjs (which provisions D1) so this PR leaves bootstrap.mjs untouched and
// avoids recurring merge conflicts. The bucket name comes from the same env var the deploy workflow
// and wrangler-render.mjs use, so a new environment is provisioned by exporting its name first, e.g.:
//   SIGMA_CSV_CACHE_NAME=sigma-csv-cache-dev node scripts/bootstrap-r2.mjs --apply
//
// Prereq: R2 must be enabled on the account (dashboard → R2 → Enable). Until then the create fails
// with `code: 10042`; no token/CLI can enable it.
import { execFileSync } from 'node:child_process';

const apply = process.argv.includes('--apply');
const csvCacheName = process.env.SIGMA_CSV_CACHE_NAME || 'sigma-csv-cache';

const cmd = ['r2', 'bucket', 'create', csvCacheName];
const line = `wrangler ${cmd.join(' ')}`;

console.log(apply ? '==> Creating R2 bucket' : '==> Dry run (pass --apply to create)');
if (apply) {
  console.log(`==> ${line}`);
  try {
    execFileSync('wrangler', cmd, { stdio: 'inherit' });
  } catch {
    console.error('!! R2 bucket create failed (may already exist, or R2 not enabled) — continuing');
  }
} else {
  console.log(`  ${line}`);
}
