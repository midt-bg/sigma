#!/usr/bin/env node
// One-time local setup: install deps, apply D1 migrations, seed sample data.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, relative, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'apps/web');
const seedFile = resolve(root, 'scripts/seed.sql');

function run(cmd, args, cwd = root) {
  console.log(`==> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd });
}

function fail(message) {
  console.error(`\n!! ${message}`);
  process.exit(1);
}

// Run pnpm without a shell. On Windows pnpm is only a `.cmd` shim: execFileSync can't find it by
// bare name (ENOENT) and Node refuses to spawn a `.cmd` without `shell: true` (EINVAL). `pnpm run`
// exports the real entry point as `npm_execpath`, so launch that directly — after checking it
// really is pnpm, since other package managers set the same variable.
const entry = process.env.npm_execpath;
if (entry && !/^pnpm(\.[cm]?js|\.exe)?$/i.test(basename(entry))) {
  fail(`This setup needs pnpm (running under ${basename(entry)}). Run: pnpm run setup`);
}
if (!entry && process.platform === 'win32') {
  fail('On Windows, start setup through pnpm. Run: pnpm run setup');
}

function pnpm(args, cwd = root) {
  if (!entry) return run('pnpm', args, cwd); // macOS/Linux started as `node scripts/setup.mjs`
  if (/\.[cm]?js$/.test(entry)) return run(process.execPath, [entry, ...args], cwd);
  return run(entry, args, cwd); // standalone pnpm executable
}

console.log('==> Sigma local setup');
pnpm(['install']);

// Local D1 state lives under apps/web/.wrangler — run migrate + seed from there
// so the api worker's `wrangler dev` sees the same database.
try {
  pnpm(['exec', 'wrangler', 'd1', 'migrations', 'apply', 'sigma', '--local'], apiDir);
  pnpm(
    ['exec', 'wrangler', 'd1', 'execute', 'sigma', '--local', '--file', relative(apiDir, seedFile)],
    apiDir,
  );
  console.log('\n==> Done. Start everything with: pnpm dev');
} catch {
  console.error('\n!! Local D1 setup failed — check the output above, then re-run `pnpm setup`.');
  process.exitCode = 1;
}
