// The --derive=full window guard, exercised through the real scripts/import.mjs.
//
// Testing the predicate alone is what let the first version ship: fullDeriveIsSafe() was green while
// the call site asked `SELECT COUNT(*) FROM contracts` and the clear it was protecting emptied
// fourteen tables. So this drives the actual script as a subprocess, with a fake `wrangler` and a
// fake `node` first on PATH, and asserts on what the script DID: whether it refused, which tables it
// named, whether it cleaned up after itself, and whether the load ever started.
//
// Run: node --test scripts/import-guard.test.mjs
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

// `wrangler` answers the probe from GUARD_FAKE_POPULATED and records every call; `node` stands in for
// the child scripts import.mjs shells out to (load-eop and friends), so a run that gets PAST the guard
// stops here instead of hitting the network. Launching the script under test with process.execPath
// keeps the real node for the parent while the child's PATH lookup finds the stub.
// The shebangs name the real interpreter outright. `#!/usr/bin/env node` would resolve through the
// very PATH these stubs sit at the front of, so the fake `node` would end up interpreting the fake
// `wrangler` and every answer would come back empty.
const FAKE_WRANGLER = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(process.env.GUARD_FAKE_LOG, JSON.stringify(argv) + '\\n');
const ci = argv.indexOf('--command');
if (argv.includes('--json') && ci !== -1) {
  const sql = argv[ci + 1];
  const populated = (process.env.GUARD_FAKE_POPULATED || '').split(',').filter(Boolean);
  const missing = (process.env.GUARD_FAKE_MISSING || '').split(',').filter(Boolean);
  const aliases = [...sql.matchAll(/AS "([^"]+)"/g)].map((m) => m[1]);
  if (aliases.length) {
    const row = {};
    for (const a of aliases) if (!missing.includes(a)) row[a] = populated.includes(a) ? 1 : 0;
    process.stdout.write(JSON.stringify([{ results: [row], success: true }]));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify([{ results: [], success: true }]));
}
process.exit(0);
`;

const FAKE_NODE = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.GUARD_FAKE_LOG, JSON.stringify(['node', ...process.argv.slice(2)]) + '\\n');
process.exit(0);
`;

function bin(dir, name, source) {
  const file = join(dir, name);
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

/** Runs the real import.mjs with the fakes in front, and returns what it did. */
function runImport(args, { populated = '', missing = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'package.json'), '{"type":"module"}');
    bin(binDir, 'wrangler', FAKE_WRANGLER);
    bin(binDir, 'node', FAKE_NODE);
    const log = join(dir, 'calls.log');
    writeFileSync(log, '');
    const res = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        GUARD_FAKE_LOG: log,
        GUARD_FAKE_POPULATED: populated,
        GUARD_FAKE_MISSING: missing,
        SIGMA_D1_NAME: 'sigma-test-local',
      },
    });
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    return {
      status: res.status,
      stderr: res.stderr ?? '',
      calls,
      refused: /refusing --derive=full/.test(res.stderr ?? ''),
      loadStarted: calls.some((c) => c[0] === 'node' && String(c[1]).includes('load-eop')),
      // The guard's own query, not merely any --json call: the derive paths issue plenty of their own.
      probe: calls.find((c) => /EXISTS\(SELECT 1 FROM contracts\)/.test(String(c[c.length - 1]))),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PARTIAL = ['--from=2026-06-01', '--derive=full'];

test('refuses a partial-window full derive over a populated corpus, before the load', () => {
  const r = runImport(PARTIAL, { populated: 'contracts,lots,tenders,bidders,authorities' });
  assert.equal(r.refused, true, r.stderr);
  assert.equal(r.status, 1);
  assert.equal(r.loadStarted, false, 'the load must not start after a refusal');
  assert.match(r.stderr, /contracts/);
});

test('a corpus with NO contracts but populated tenders still refuses', () => {
  // The regression this guard exists for. The previous call site asked COUNT(*) FROM contracts, so
  // exactly this state - the one a half-failed run leaves behind - was waved through, and the rebuild
  // would then drop tenders, bidders and authorities with nothing to reload them from.
  const r = runImport(PARTIAL, { populated: 'tenders,bidders,authorities' });
  assert.equal(r.refused, true, r.stderr);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tenders/);
  assert.doesNotMatch(r.stderr, /including [^\n]*\bcontracts\b/);
});

test('refuses when the probe cannot answer for every cleared table', () => {
  // A missing table makes safeD1 return nothing at all, which would otherwise read as "no corpus".
  const r = runImport(PARTIAL, { populated: 'contracts', missing: 'facet_counts' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not read the corpus/);
});

test('an empty corpus is the initial backfill and passes', () => {
  const r = runImport(PARTIAL, { populated: '' });
  assert.equal(r.refused, false, r.stderr);
  assert.equal(r.loadStarted, true, 'the load should start when there is nothing to lose');
});

test('a window reaching the start of the feed passes even over a full corpus', () => {
  const r = runImport(['--from=2020-01-01', '--derive=full'], {
    populated: 'contracts,authorities',
  });
  assert.equal(r.refused, false, r.stderr);
  assert.equal(r.loadStarted, true);
});

test('a slice derive is never probed at all', () => {
  const r = runImport(['--from=2026-06-01', '--derive=slice'], { populated: 'contracts' });
  assert.equal(r.refused, false, r.stderr);
  assert.equal(r.probe, undefined, 'slice derives must not pay for the corpus probe');
});

test('the probe covers every table the SQL clears, not a subset', () => {
  const r = runImport(PARTIAL, { populated: 'contracts' });
  const sql = String(r.probe[r.probe.indexOf('--command') + 1]);
  const cleared = readFileSync(resolve(ROOT, 'scripts/normalize-raw.sql'), 'utf8')
    .split(/\r?\n/)
    .slice(
      readFileSync(resolve(ROOT, 'scripts/normalize-raw.sql'), 'utf8')
        .split(/\r?\n/)
        .findIndex((l) => /^--\s*@full-clear/.test(l.trim())),
    );
  for (const line of cleared) {
    if (line.trim() === '') break;
    const hit = line.trim().match(/^DELETE\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)\s*;$/i);
    if (hit) assert.match(sql, new RegExp(`FROM ${hit[1]}\\)`), `probe is missing ${hit[1]}`);
  }
});

test('a refusal leaves no transient staging behind', () => {
  const r = runImport(PARTIAL, { populated: 'contracts' });
  const files = r.calls.filter((c) => c.includes('--file')).map((c) => c[c.indexOf('--file') + 1]);
  assert.ok(
    files.some((f) => /drop-transient-staging\.sql$/.test(String(f))),
    'the guard should tear down the staging it found created',
  );
});
