// End-to-end coverage of the SHIP PATH ITSELF — the one thing unit tests of the helpers cannot give.
//
// Three times a refactor of this script silently dropped a guarantee while the suite stayed green:
// when main() called applyTableChunks, again after that moved into runShip(), and again when a first
// cut of THIS file asserted only on request filenames and counts — so mutations that shipped an empty
// payload, a wipe that deleted nothing, or every request to a PRODUCTION slot all passed.
//
// The fix is to stop trusting a stub: the fake `wrangler` here APPLIES each --file to a real sqlite
// target and answers each --command FROM that target. The assertions are then about what the target
// actually holds, which no amount of correct-looking request plumbing can fake.
//
// Run: node --test scripts/ship-e2e.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_BATCH_ROWS,
  MAX_STATEMENTS_PER_REQUEST,
  PACE_MS,
  TABLES,
} from './ship-related-persons.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SCRIPT = resolve(HERE, 'ship-related-persons.mjs');
const MIG = resolve(ROOT, 'packages/db/migrations/0003_related_persons_foundation.sql');
const D1_NAME = 'sigma-test-local';

// Derived from BOTH production constants, and the run below does NOT override either: one row past
// what a single default request can carry, so chunking is exercised at the shipped settings. Forcing
// it with --max-statements-per-request=1 (the first cut of this file) left the real constant free to
// be retuned to infinity with the suite still green.
const LINKS = MAX_STATEMENTS_PER_REQUEST * MAX_BATCH_ROWS + 1;
const EXPECTED_CHUNKS = Math.ceil(LINKS / MAX_BATCH_ROWS / MAX_STATEMENTS_PER_REQUEST);
// The failure-mode tests below do not need the full-size corpus — they force chunking with a flag and
// keep the fixture small, so only the one test that constrains the defaults pays for 10k rows.
const LINKS_SMALL = MAX_BATCH_ROWS * 2 + 1;

const sqlite = (db, input) => execFileSync('sqlite3', ['-bail', db], { input, stdio: 'pipe' });

// Unlike the other scripts/*.test.mjs this one needs the `sqlite3` BINARY (present on ubuntu-latest
// and in the devcontainer): the fake wrangler applies real SQL to a real database, which is the whole
// reason these assertions mean anything. Say so up front — a missing binary would otherwise surface as
// an opaque ENOENT from whichever test happened to run first. Failing, never skipping: a skip here
// silently returns the suite to the state where mutations walked through it.
if (spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).error) {
  throw new Error('scripts/ship-e2e.test.mjs requires the sqlite3 binary on PATH');
}

/** The five served tables plus the two FK parents they reference. */
const SCHEMA = `PRAGMA foreign_keys=ON;
CREATE TABLE bidders(id TEXT PRIMARY KEY);
CREATE TABLE authorities(id TEXT PRIMARY KEY);
.read ${MIG}
INSERT INTO bidders(id) VALUES('eik:1');
INSERT INTO authorities(id) VALUES('auth:1');`;

const corpus = (links) => `
INSERT INTO persons(id,name) VALUES('p1','П Тест');
INSERT INTO declarations(id,person_id,xml_file,folder_year,template,source_url) VALUES('d1','p1','x.xml','2024','assets','u');
INSERT INTO declared_interests(id,declaration_id,entity_raw,entity_key,kind) VALUES('di1','d1','E','e','shares');
${Array.from(
  { length: links },
  (_, i) =>
    `INSERT INTO interest_links(id,link_key,person_id,bidder_id,eik,entity_key,matcher_version,publish_tier,relation,status) VALUES('il${i}','p1|${i}','p1','eik:1','1','e','v1','B_distinctive','owns','published');`,
).join('\n')}
`;
// interest_link_authorities is deliberately left EMPTY above: its expected count is 0, which is the
// only shape where `Number(null) === 0` would let an unanswered read-back pass for "table is empty".

const STALE = `
INSERT INTO persons(id,name) VALUES('stale','Стар запис');
INSERT INTO declarations(id,person_id,xml_file,folder_year,template,source_url) VALUES('sd','stale','s.xml','2019','assets','u');
INSERT INTO declared_interests(id,declaration_id,entity_raw,entity_key,kind) VALUES('sdi','sd','S','s','shares');
INSERT INTO interest_links(id,link_key,person_id,bidder_id,eik,entity_key,matcher_version,publish_tier,relation,status) VALUES('sil','stale|0','stale','eik:1','1','s','v0','B_distinctive','owns','published');
INSERT INTO interest_link_authorities(link_key,authority_id,authority_name) VALUES('stale|0','auth:1','A');`;

const EXPECTED_ROWS = {
  persons: 1,
  declarations: 1,
  declared_interests: 1,
  interest_links: LINKS,
  interest_link_authorities: 0,
};

/**
 * A `wrangler` that touches no network but is otherwise faithful: it records the FULL argv, applies
 * every --file to the target sqlite DB with foreign keys ON (so a wrong wipe order fails exactly as
 * D1 would), and answers every --command from that same DB. Notices go to stderr and pure JSON to
 * stdout, mirroring real `wrangler --json`.
 *
 * SHIP_FAKE_SKIP  — drop one --file by name, to simulate a request that never landed.
 * SHIP_FAKE_NULLN — answer the read-back with a non-numeric count, to exercise the fail-closed guard.
 * SHIP_FAKE_NOISE — emit a `[WARNING]`-shaped line on stdout before the JSON.
 * SHIP_FAKE_READFAIL — make the read-back call itself fail, so the catch path is exercised.
 */
function fakeWrangler(dir) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(dir, 'calls.jsonl');
  const target = join(dir, 'target.sqlite');
  // Seeded with STALE rows on purpose: against an empty target a wipe that deletes nothing is
  // indistinguishable from a correct one, and that mutation escaped the first cut of this test.
  sqlite(target, SCHEMA + STALE);
  const exe = join(bin, 'wrangler');
  writeFileSync(
    exe,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const argv = process.argv.slice(2);
const at = (f) => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : null);
const file = at('--file');
const command = at('--command');
const TARGET = ${JSON.stringify(target)};
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, file: file && file.split('/').pop() }) + '\\n');
const run = (input) =>
  execFileSync('sqlite3', ['-bail', TARGET], { input: 'PRAGMA foreign_keys=ON;\\n' + input, encoding: 'utf8' });
try {
  if (file) {
    const skip = process.env.SHIP_FAKE_SKIP;
    if (!skip || !file.endsWith(skip)) run('.read ' + file);
  } else if (command) {
    if (process.env.SHIP_FAKE_READFAIL) { process.stderr.write('read-back exploded'); process.exit(1); }
    const rows = JSON.parse(run('.mode json\\n' + command) || '[]');
    const shaped = process.env.SHIP_FAKE_NULLN
      ? rows.map((r) => (r.t === process.env.SHIP_FAKE_NULLN ? { ...r, n: null } : r))
      : rows;
    if (process.env.SHIP_FAKE_NOISE) process.stdout.write('▲ [WARNING] Processing wrangler.jsonc\\n');
    process.stdout.write(JSON.stringify([{ results: shaped, success: true }]));
  }
} catch (err) {
  process.stderr.write(String(err.stderr || err.message));
  process.exit(1);
}
`,
    { mode: 0o755 },
  );
  chmodSync(exe, 0o755);
  // package.json so the extensionless fake is unambiguously ESM wherever os.tmpdir() lives.
  writeFileSync(join(bin, 'package.json'), '{"type":"module"}');
  return {
    bin,
    target,
    calls: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    count: (t) =>
      Number(execFileSync('sqlite3', [target, `SELECT COUNT(*) FROM ${t};`]).toString()),
  };
}

function runShip(
  dir,
  {
    env = {},
    links = LINKS_SMALL,
    forceChunks = true,
    minLinks = 1,
    remote = false,
    yes = false,
    emit = null,
  } = {},
) {
  const work = join(dir, 'work.sqlite');
  sqlite(work, SCHEMA + corpus(links));
  const fake = fakeWrangler(dir);
  const res = spawnSync(
    process.execPath,
    [
      SCRIPT,
      `--work-db=${work}`,
      ...(remote ? ['--remote'] : ['--local']),
      ...(yes ? ['--yes'] : []),
      ...(emit ? [`--emit=${emit}`] : []),
      `--min-links=${minLinks}`,
      // The pacing delay is always zeroed to keep the suite quick — it is covered by the runShip unit
      // tests. Whether the REQUEST SIZE is overridden matters: the defaults-constraining test leaves
      // it alone on purpose.
      '--pace-ms=0',
      ...(forceChunks ? ['--max-statements-per-request=1'] : []),
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env,
        SIGMA_D1_NAME: D1_NAME,
        PATH: `${fake.bin}:${process.env.PATH}`,
      },
    },
  );
  return { res, fake };
}

test('a real ship run leaves the target holding exactly what the work DB held', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { res, fake } = runShip(dir, { links: LINKS, forceChunks: false });
  assert.equal(res.status, 0, `ship failed:\n${res.stderr}`);

  // The assertion that no amount of correct-looking plumbing can fake: the SQL really applied.
  for (const [table, n] of Object.entries({ ...EXPECTED_ROWS, interest_links: LINKS }))
    assert.equal(fake.count(table), n, `${table} did not land`);

  const calls = fake.calls();
  // Every request must name the declared DB and stay local — a mutation that retargets a production
  // slot is the single highest-consequence regression this script can suffer.
  for (const c of calls) {
    assert.deepEqual(c.argv.slice(0, 3), ['d1', 'execute', D1_NAME]);
    assert.ok(c.argv.includes('--local'), `request escaped --local: ${c.argv.join(' ')}`);
    assert.ok(!c.argv.includes('--remote'), `request went remote: ${c.argv.join(' ')}`);
  }

  const applies = calls.filter((c) => c.file);
  assert.match(applies[0].file, /^0_wipe\./, 'the wipe must be the first request');

  // Chunking: a table past the batch budget must arrive as several CONTIGUOUSLY numbered requests.
  const nums = applies
    .map((c) => /^interest_links\.(\d+)\./.exec(c.file))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  assert.ok(
    nums.length >= 2,
    `interest_links must be chunked, got ${JSON.stringify(applies.map((c) => c.file))}`,
  );
  assert.equal(nums.length, EXPECTED_CHUNKS);
  assert.deepEqual(
    nums,
    Array.from({ length: nums.length }, (_, i) => i + 1),
  );

  // The read-back must be the LAST thing the run does, and must count each table from that table.
  const last = calls.at(-1);
  assert.ok(last.argv.includes('--command'), 'the read-back must come after the inserts');
  const sql = last.argv[last.argv.indexOf('--command') + 1];
  for (const table of TABLES)
    assert.match(
      sql,
      new RegExp(`COUNT\\(\\*\\) AS n FROM "${table}"`),
      `${table} not really counted`,
    );
});

test('a request that never landed fails the run', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-e2e-short-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { res } = runShip(dir, { env: { SHIP_FAKE_SKIP: 'interest_links.2.sql' } });
  assert.notEqual(res.status, 0, 'a short target must fail the run');
  assert.match(res.stderr, /ship verification FAILED/);
  assert.match(res.stderr, /interest_links: shipped \d+, target has \d+/);
});

test('a read-back that answers with a non-number fails closed', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-e2e-nan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // `Number(null)` is 0, which would read as "the table is empty" and quietly pass.
  const { res } = runShip(dir, { env: { SHIP_FAKE_NULLN: 'interest_link_authorities' } });
  assert.notEqual(res.status, 0, 'an unanswered count must fail the run');
  assert.match(res.stderr, /ship verification FAILED/);
});

test('a bracketed notice on stdout does not corrupt the read-back', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-e2e-noise-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // This is a HYPOTHETICAL, and saying so is the point. `wrangler d1 execute --json` was run against
  // the real tool afterwards: the notice goes to stderr, stdout is clean JSON, and execFileSync
  // returns stdout alone. So this models a stream layout wrangler does not currently produce.
  //
  // It stays as a cheap guard against a future release moving notices onto stdout — but the PR that
  // added it billed the scan as fixing an observed failure, which it never was. A fake is a claim
  // about the world; this one went unchecked, the suite was green, and the false claim shipped.
  // Anything modelled here that has not been confirmed against the real binary gets labelled as such.
  const { res } = runShip(dir, { env: { SHIP_FAKE_NOISE: '1' } });
  assert.equal(res.status, 0, `a stdout notice broke the read-back:\n${res.stderr}`);
});

// The guards below all sit at UNPROTECTED call sites: deleting each one, or moving it after the
// destructive run, left the whole suite green. They are the last thing standing between a mistyped
// flag and a wiped production surface, so each gets an end-to-end test that also proves NO request
// was issued before the refusal.
// `d1 info` (the id resolution the authorization guard itself needs) is a read and is fine; what must
// never happen before a refusal is an `execute`, which is what carries the wipe.
const noWrites = (fake) => {
  try {
    return !fake.calls().some((c) => c.argv[0] === 'd1' && c.argv[1] === 'execute');
  } catch {
    return true; // the log file is only created by the first invocation
  }
};

test('an under-floor corpus refuses to wipe, before any request', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-e2e-floor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { res, fake } = runShip(dir, { minLinks: LINKS_SMALL + 1 });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /refusing to ship/i);
  assert.ok(noWrites(fake), 'the refusal must come before the wipe');
});

test('a bare --remote refuses without --yes, before any request', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-e2e-remote-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { res, fake } = runShip(dir, { remote: true });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--remote requires --yes/);
  assert.ok(noWrites(fake), 'the refusal must come before the wipe');
});

test('a --remote ship with no declared environment refuses, before any request', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-e2e-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { res, fake } = runShip(dir, { remote: true, yes: true, env: { SIGMA_SHIP_ENV: '' } });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /SIGMA_SHIP_ENV/);
  assert.ok(noWrites(fake), 'the refusal must come before the wipe');
});

test('a read-back that cannot answer at all fails the run', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-e2e-readfail-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // „a verification step that cannot verify must not pass" — the catch returning {} is what makes
  // that true, and returning the expectation instead would silently pass.
  const { res } = runShip(dir, { env: { SHIP_FAKE_READFAIL: '1' } });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /ship verification FAILED/);
  assert.match(res.stderr, /no answer/);
});

test('--emit writes a guarded wipe plus one file per table, and touches no database', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-e2e-emit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const out = join(dir, 'emitted');
  const { res, fake } = runShip(dir, { emit: out });
  assert.equal(res.status, 0, `emit failed:\n${res.stderr}`);
  assert.ok(noWrites(fake), '--emit must not touch a database');

  const wipe = readFileSync(join(out, '0_wipe.sql'), 'utf8');
  assert.match(wipe, /DESTRUCTIVE, UNGUARDED/, 'the emitted wipe must carry its warning header');
  for (const table of TABLES) assert.match(wipe, new RegExp(`DELETE FROM "${table}"`));
  for (const table of TABLES) {
    const body = readFileSync(join(out, `${table}.sql`), 'utf8');
    if (table === 'interest_link_authorities') assert.equal(body, '', 'empty table, empty file');
    else assert.match(body, new RegExp(`INSERT INTO "${table}"`));
  }
});
