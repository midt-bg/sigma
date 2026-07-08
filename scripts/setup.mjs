#!/usr/bin/env node
// One-time local setup: install deps, apply D1 migrations, seed sample data.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'apps/web');
const seedFile = resolve(root, 'scripts/seed.sql');

function run(cmd, args, cwd = root) {
  console.log(`==> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd });
}

console.log('==> Sigma local setup');
run('pnpm', ['install']);

// Local D1 state lives under apps/web/.wrangler — run migrate + seed from there
// so the api worker's `wrangler dev` sees the same database.
try {
  run('wrangler', ['d1', 'migrations', 'apply', 'sigma', '--local'], apiDir);
  run('wrangler', ['d1', 'execute', 'sigma', '--local', '--file', seedFile], apiDir);
  console.log('\n==> Done. Start everything with: pnpm dev');
} catch {
  console.error(
    '\n!! Local D1 setup failed — check that wrangler is on PATH, then re-run `pnpm setup`.',
  );
  process.exitCode = 1;
}
