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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
    // CU_NO_FRESHNESS models an INTERRUPTED derive: refresh-slice.sql NULLed as_of in its first batch
    // and never reached the last one that rewrites it. The column is there; the date is not.
    const date = process.env.CU_NO_FRESHNESS ? null : '2026-07-27';
    process.stdout.write(JSON.stringify([{ results: [{ max_loaded_date: date }], success: true }]));
    process.exit(0);
  }
  // The served-corpus probe: a COUNT, never a date. Checked AFTER raw_contracts above, which matches
  // first and exits, so this only ever sees the contracts query. CU_COLD models an empty database.
  if (/FROM\\s+contracts/.test(sql)) {
    const n = process.env.CU_COLD ? 0 : 199723;
    process.stdout.write(JSON.stringify([{ results: [{ n }], success: true }]));
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
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.CU_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(0);
`;

// Same idea for sqlite3: the --work-db path applies the migrations to a throwaway work DB before it ever
// reaches the catch-up planning we are testing. Nothing here inspects that DB, so a no-op keeps the test
// about planning rather than about schema.
const FAKE_SQLITE3 = `#!${process.execPath}
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
      ['sqlite3', FAKE_SQLITE3],
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

// ── an INTERRUPTED derive must not be mistaken for a first run ──────────────────────────────────────
// Both watermark witnesses are transient and can be empty at once: raw_contracts is torn down after
// every load, and refresh-slice.sql NULLs data_freshness.as_of in its first batch and rewrites it only
// in its last few. Over a POPULATED surface that is not "nothing is loaded", it is "the last derive was
// interrupted" — and planning from the default start would re-derive the whole feed over live data.

test('an interrupted derive over a populated surface refuses instead of re-deriving everything', () => {
  const r = runImport(['--catchup', '--plan-only'], { CU_NO_FRESHNESS: '1' });
  assert.notEqual(r.status, 0, 'planning must refuse when the watermark is gone but data is not');
  assert.match(r.stderr, /no load watermark, but the served surface is not empty/);
  // The refusal has to be actionable, or an operator just re-runs it and gets the same wall.
  assert.match(r.stderr, /--from=YYYY-MM-DD/);
  assert.doesNotMatch(r.stdout, /derive=full/, 'it must not have planned a full re-derive anyway');
});

test('the served-corpus probe is a COUNT, and runs only as a last resort', () => {
  // Two things at once: the probe is reached when both watermarks are silent, and it asks HOW MANY —
  // never MAX(published_at). Publication dates are not the bucket days the window is computed from, so
  // a date from here could move the window past buckets that were never loaded and skip them silently.
  const interrupted = runImport(['--catchup', '--plan-only'], { CU_NO_FRESHNESS: '1' });
  const probe = interrupted.calls
    .map((c) => String(c[c.length - 1]))
    .find((sql) => /FROM\s+contracts/.test(sql) && !/raw_contracts/.test(sql));
  assert.ok(probe, 'nothing probed the served corpus after freshness came back NULL');
  assert.match(probe, /COUNT\(\*\)/, 'the probe must count rows');
  assert.doesNotMatch(probe, /MAX\s*\(/, 'the served corpus must never be read as a watermark');

  const healthy = runImport(['--catchup', '--plan-only']);
  const probedWhenHealthy = healthy.calls
    .map((c) => String(c[c.length - 1]))
    .some((sql) => /FROM\s+contracts/.test(sql) && !/raw_contracts/.test(sql));
  assert.ok(!probedWhenHealthy, 'data_freshness answered; the served corpus must not be probed');
});

test('a genuinely cold database still plans the full backfill', () => {
  // The honest first run: no watermark AND no corpus. That one really does want the whole feed, and the
  // refusal must not stand in its way.
  const r = runImport(['--catchup', '--plan-only'], { CU_NO_FRESHNESS: '1', CU_COLD: '1' });
  assert.equal(r.status, 0, `a cold database must still plan:\n${r.stderr}`);
  assert.match(r.stdout, /derive=full/);
});

test('an explicit --from is the escape hatch and is honoured', () => {
  // An operator who knows where the interrupted run got to can say so, and the refusal steps aside.
  const r = runImport(['--catchup', '--plan-only', '--from=2026-08-20'], { CU_NO_FRESHNESS: '1' });
  assert.equal(r.status, 0, `--from should let planning proceed:\n${r.stderr}`);
  assert.match(r.stdout, /from=2026-08-20/);
});

test('the advertised recovery is EXECUTABLE — a narrow --from window can be a slice', () => {
  // The recovery the refusal recommends has to survive past planning. This branch used to hardcode
  // derive=full, so `--from=<recent>` printed a fine plan and the live run then hit the full-derive
  // guard (a narrow window + full derive rebuilds from staging and drops everything older). Advice that
  // only works under --plan-only is worse than no advice, so the plan must carry the slice through.
  const r = runImport(['--catchup', '--plan-only', '--from=2026-08-20', '--derive=slice'], {
    CU_NO_FRESHNESS: '1',
  });
  assert.equal(r.status, 0, `the recommended recovery must plan:\n${r.stderr}`);
  assert.match(r.stdout, /derive=slice/, 'an explicit --derive=slice must reach the plan');
  assert.doesNotMatch(r.stdout, /derive=full/);
});

test('without an explicit --derive the no-watermark branch still defaults to full', () => {
  // The cold-start default is unchanged: a first run over the whole feed is a full derive.
  const r = runImport(['--catchup', '--plan-only'], { CU_NO_FRESHNESS: '1', CU_COLD: '1' });
  assert.match(r.stdout, /derive=full/);
});

test('the refusal names the recovery it actually supports', () => {
  // Pins the message to the flags the code honours, so the two cannot drift apart again.
  const r = runImport(['--catchup', '--plan-only'], { CU_NO_FRESHNESS: '1' });
  assert.match(r.stderr, /--from=YYYY-MM-DD --derive=slice/);
});

// ── the recommended slice must not be silently swallowed by --work-db ───────────────────────────────
// That path rebuilds a fresh work DB from the window and ships it WHOLESALE, so it acts as a full derive
// whatever the plan says — it prints `derive` it does not obey. Fine for a window reaching the start of
// the feed; for the tail the refusal above recommends, it would replace the served corpus with that tail.

function withWorkDb(args, env, { seed = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'catchup-workdb-'));
  const workDb = join(dir, 'w.sqlite');
  try {
    // `seed` puts a pre-existing work DB in place, so a test can prove the refusal did not destroy it.
    if (seed) writeFileSync(workDb, 'PRE-EXISTING');
    const r = runImport([...args, `--work-db=${workDb}`], env);
    // Read the outcome BEFORE the finally below removes the directory — the assertions run afterwards.
    const workDbSurvived = existsSync(workDb);
    return {
      ...r,
      workDb,
      workDbSurvived,
      workDbContent: workDbSurvived ? readFileSync(workDb, 'utf8') : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('--work-db catch-up refuses a slice instead of shipping the tail wholesale', () => {
  const r = withWorkDb(['--catchup', '--from=2026-08-20', '--derive=slice'], {
    CU_NO_FRESHNESS: '1',
  });
  assert.notEqual(r.status, 0, 'a slice this path cannot honour must not proceed');
  assert.match(r.stderr, /--work-db catch-up can only run a full derive \(got --derive=slice\)/);
  assert.match(r.stderr, /dropped from the served surface/, 'it must say what would be lost');
  // And it must stop before doing ANY of the work it would have to undo. The fake `node` logs its argv,
  // so an actual load would show up in the call log.
  assert.ok(
    !r.calls.some((c) => c.join(' ').includes('load-eop')),
    'it must refuse before the load runs',
  );
  assert.ok(
    !r.calls.some((c) => c.join(' ').includes('ship-domain')),
    'it must refuse before shipping',
  );
});

test('--work-db catch-up refuses WITHOUT destroying the existing work DB', () => {
  // The refusal used to arrive after the path had already deleted the caller's work DB and re-applied
  // the migrations — announcing „I will not proceed" once the damage was done.
  const r = withWorkDb(
    ['--catchup', '--from=2026-08-20', '--derive=slice'],
    { CU_NO_FRESHNESS: '1' },
    { seed: true },
  );
  assert.notEqual(r.status, 0);
  assert.ok(r.workDbSurvived, 'the refusal deleted the work DB it refused to fill');
  assert.equal(r.workDbContent, 'PRE-EXISTING', 'the work DB was rewritten anyway');
});

test('--work-db catch-up refuses an UNRECOGNISED derive too, not just a slice', () => {
  // The allowlist (review ydimitrof, #337). validateDeriveMode runs on the live path only, so a
  // slice-only check would let `--derive=typo` through to the wholesale ship — the same silent
  // replacement of the served corpus, reached by a value nobody spelled correctly.
  const r = withWorkDb(['--catchup', '--from=2026-08-20', '--derive=typo'], {
    CU_NO_FRESHNESS: '1',
  });
  assert.notEqual(r.status, 0, 'an unrecognised derive must not reach the wholesale ship');
  assert.match(r.stderr, /can only run a full derive \(got --derive=typo\)/);
  assert.ok(
    !r.calls.some((c) => c.join(' ').includes('load-eop')),
    'it must refuse before the load runs',
  );
});

test('a bare --from is not a window — the refusal still explains itself', () => {
  // `--from` with no value parses as `true` (review lyubomir-bozhinov, #337). Counted as present, it
  // skipped the refusal and the operator hit validateDay's „windowFrom must be YYYY-MM-DD" much later,
  // which explains nothing about the interrupted derive that actually caused it.
  const r = runImport(['--catchup', '--plan-only', '--from'], { CU_NO_FRESHNESS: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no load watermark, but the served surface is not empty/);
  assert.doesNotMatch(
    r.stderr,
    /windowFrom must be/,
    'the cryptic error must not be what surfaces',
  );
});

test('--work-db catch-up still runs when the plan is a full derive', () => {
  // The guard is aimed at the one unsafe combination, not at the path itself.
  const r = withWorkDb(['--catchup', '--derive=full'], { CU_NO_FRESHNESS: '1', CU_COLD: '1' });
  assert.equal(r.status, 0, `a full-window catch-up must still run:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /cannot honour --derive=slice/);
});
