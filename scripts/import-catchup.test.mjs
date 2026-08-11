// safeD1's missing-table detection, exercised through the real scripts/import.mjs.
//
// safeD1 has to tell "this table does not exist yet" (recoverable — latestLoadedDate falls back to
// data_freshness) apart from every other failure (must propagate). Getting that wrong breaks
// `import --catchup --plan-only` in its NORMAL state: drop-transient-staging removes raw_contracts in
// a finally, and --plan-only exits before the main flow recreates it. #277 fixed it; nothing tested it,
// because import.mjs runs on import and cannot be imported. The subprocess harness from #270 can.
//
// Run: node --test scripts/import-catchup.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SCRIPT = resolve(HERE, 'import.mjs');

// VERIFIED AGAINST THE REAL BINARY, not imagined — the whole point of this test is the stream layout,
// so modelling it from memory would test nothing. Observed from
// `wrangler d1 execute sigma --local --json --command "SELECT 1 FROM no_such_table_xyz"`:
//
//   exit code : 1
//   stdout    : {"error":{"text":"no such table: no_such_table_xyz: SQLITE_ERROR"}}
//   stderr    : ▲ [WARNING] Processing wrangler.jsonc configuration: ...
//   err.message from execFileSync : "Command failed: wrangler d1 execute ..."
//
// So the SQLite error is on STDOUT while wrangler's notices are on STDERR, and the exception message
// carries neither. That asymmetry is exactly what the old `err.message`-only check missed.
const SQLITE_ERROR_ON_STDOUT = '{"error":{"text":"no such table: raw_contracts: SQLITE_ERROR"}}';

const FAKE_WRANGLER = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(process.env.CU_LOG, JSON.stringify(argv) + '\\n');
const ci = argv.indexOf('--command');
if (ci !== -1) {
  const sql = argv[ci + 1];
  if (/raw_contracts/.test(sql)) {
    if (process.env.CU_OTHER_ERROR) {
      process.stdout.write(JSON.stringify({ error: { text: 'database is locked: SQLITE_BUSY' } }));
    } else {
      process.stdout.write(${JSON.stringify(SQLITE_ERROR_ON_STDOUT)});
    }
    process.stderr.write('\\u25b2 [WARNING] Processing wrangler.jsonc configuration:\\n');
    process.exit(1);
  }
  if (/data_freshness/.test(sql)) {
    process.stdout.write(JSON.stringify([{ results: [{ max_loaded_date: '2026-07-27' }], success: true }]));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify([{ results: [], success: true }]));
}
process.exit(0);
`;

// Stands in for the child scripts import.mjs shells out to, so a run that gets past planning stops
// here rather than reaching the network. The parent runs under process.execPath, so it keeps the real
// node while the child's PATH lookup finds this.
const FAKE_NODE = `#!${process.execPath}
process.exit(0);
`;

function runImport(args, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'catchup-'));
  try {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'package.json'), '{"type":"module"}');
    for (const [name, src] of [
      ['wrangler', FAKE_WRANGLER],
      ['node', FAKE_NODE],
    ]) {
      writeFileSync(join(binDir, name), src);
      chmodSync(join(binDir, name), 0o755);
    }
    const log = join(dir, 'calls.log');
    writeFileSync(log, '');
    const res = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CU_LOG: log, ...env },
    });
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a missing raw_contracts falls back to data_freshness instead of crashing', () => {
  // The reported failure: --plan-only in its normal steady state, with the transient staging gone.
  const r = runImport(['--catchup', '--plan-only']);
  assert.equal(r.status, 0, `--plan-only should survive a missing raw_contracts:\n${r.stderr}`);
  assert.match(r.stdout, /catchup plan/);
  // The date can only have come from the data_freshness fallback — raw_contracts never answered.
  assert.match(r.stdout, /maxLoadedDate=2026-07-27/);
});

test('the fallback query is actually reached, not skipped', () => {
  // Guards against a future "fix" that returns a plan without asking data_freshness at all, which
  // would pass the assertion above by accident.
  const r = runImport(['--catchup', '--plan-only']);
  const asked = r.calls.some((c) => /data_freshness/.test(String(c[c.length - 1])));
  assert.ok(asked, 'safeD1 swallowed the error but nothing consulted data_freshness');
});

test('an error that is NOT a missing table still propagates', () => {
  // safeD1 must not become a blanket catch. A locked database is not "no corpus yet", and treating it
  // as one would let the catch-up plan be computed from a lie.
  const r = runImport(['--catchup', '--plan-only'], { CU_OTHER_ERROR: '1' });
  assert.notEqual(r.status, 0, 'a SQLITE_BUSY must not be swallowed as an empty result');
});
