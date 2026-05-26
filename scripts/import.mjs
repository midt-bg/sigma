#!/usr/bin/env node
// Sigma — full ETL: a clean, reproducible import of the admin ЦАИС ЕОП export into D1.
//
//   node scripts/import.mjs            # local D1
//   node scripts/import.mjs --reset    # drop the local D1 first (true from-scratch; local only)
//   node scripts/import.mjs --remote   # remote D1 (needs `wrangler login` + a real database_id)
//
// Pipeline (each step idempotent; scoped wipes let a re-run fully refresh):
//   1. schema           wrangler d1 migrations apply        (the single 0000_init.sql)
//   2. staging          scripts/load-admin.mjs --apply      (Contracts / Tenders / Annexes, 2020–2026)
//   3. amendments       scripts/derive-amendments.sql       (current_value + annex_count onto contracts)
//   4. fx rates         scripts/load-fx.mjs --apply         (ECB signing-date rates for foreign currencies)
//   5. domain           scripts/normalize-egov.sql          (rebuild authorities/tenders/lots/bidders/contracts)
//   6. precompute       scripts/precompute.sql              (rollups + FTS search + per-contract EUR timeline)
//
// The OCDS feed (scripts/load-ocds.mjs) is the SEPARATE go-forward 2026+ delta — the admin export
// already covers through its snapshot, so run OCDS afterwards (with dedup, admin wins) only when
// there is genuinely newer data. See docs/etl-pipeline.md.

import { execFileSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'apps/api');
const remote = process.argv.includes('--remote');
const reset = process.argv.includes('--reset');
const loc = remote ? '--remote' : '--local';
const passthru = remote ? ['--remote'] : [];

function run(cmd, args, cwd = root) {
  console.log(`\n==> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd });
}
const execSql = (file) => run('wrangler', ['d1', 'execute', 'sigma', loc, '--file', file], apiDir);

if (reset) {
  if (remote) {
    console.error('!! --reset is local-only (refusing to wipe remote). Drop/recreate the remote D1 manually.');
    process.exit(1);
  }
  const state = resolve(apiDir, '.wrangler/state/v3/d1');
  if (existsSync(state)) {
    rmSync(state, { recursive: true, force: true });
    console.log('==> reset: removed local D1 state');
  }
}

console.log(`==> Sigma import (${remote ? 'REMOTE' : 'local'})`);
run('wrangler', ['d1', 'migrations', 'apply', 'sigma', loc], apiDir); // 1. schema
run('node', ['scripts/load-admin.mjs', '--apply', ...passthru]); //        2. staging
execSql(resolve(root, 'scripts/derive-amendments.sql')); //                3. amendments rollup
run('node', ['scripts/load-fx.mjs', '--apply', ...passthru]); //           4. fx rates
execSql(resolve(root, 'scripts/load-nuts.sql')); //                        4b. NUTS region reference
execSql(resolve(root, 'scripts/normalize-egov.sql')); //                   5. domain rebuild
execSql(resolve(root, 'scripts/precompute.sql')); //                       6. rollups + FTS + EUR timeline

console.log('\n==> import complete.');
