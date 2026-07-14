#!/usr/bin/env node
// Seeds the hermetic E2E database, run as the pre-step of `test:e2e` (before Playwright starts the
// dev server). Kept a plain node script — not a Playwright globalSetup — because Playwright
// transpiles setup files into a cache dir, which moved the relative --persist-to target off the
// source tree and silently left the DB empty. Run via pnpm, cwd is always apps/web.
//
// migrations apply → e2e/seed-e2e.sql (raw entities + domain contracts) → precompute.sql (rollups +
// FTS search index). Uses a dedicated D1 persist dir (matching vite.config's E2E branch) so it never
// touches the developer's local dev DB. Fail-loud: throws if the derive left home_totals empty.
import { execFileSync } from 'node:child_process';

const PERSIST = '.wrangler/e2e-state';
const D1 = ['d1', 'execute', 'sigma', '--local', '--persist-to', PERSIST];

function wrangler(args, opts = {}) {
  return execFileSync('pnpm', ['exec', 'wrangler', ...args], {
    stdio: opts.capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
}

wrangler(['d1', 'migrations', 'apply', 'sigma', '--local', '--persist-to', PERSIST]);
wrangler([...D1, '--file', 'e2e/seed-e2e.sql']);
wrangler([...D1, '--file', '../../scripts/precompute.sql']);

const out = wrangler([...D1, '--command', 'SELECT COUNT(*) AS n FROM home_totals;', '--json'], {
  capture: true,
});
const rows = JSON.parse(out)?.[0]?.results ?? [];
if (Number(rows[0]?.n) < 1) {
  throw new Error(`E2E seed failed: home_totals is empty after precompute (persist=${PERSIST}).`);
}
console.log('E2E database seeded (rollups + FTS index built).');
