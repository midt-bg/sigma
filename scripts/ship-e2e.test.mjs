// End-to-end coverage of the SHIP PATH ITSELF — the one thing unit tests of the helpers cannot give.
//
// Twice now a refactor of this script has silently dropped a guarantee while the whole suite stayed
// green: first when main() called applyTableChunks, then again after that call site moved into
// runShip(). Both times the helper was well tested and the CALL was not. The only test that cannot be
// fooled that way drives the real script as a subprocess and watches what it actually asks wrangler
// to do, so this file does exactly that: a fake `wrangler` first on PATH records every invocation.
//
// Run: node --test scripts/ship-e2e.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLES } from './ship-related-persons.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SCRIPT = resolve(HERE, 'ship-related-persons.mjs');
const MIG = resolve(ROOT, 'packages/db/migrations/0003_related_persons_foundation.sql');

// insertStatements packs up to MAX_BATCH_ROWS (400) rows per statement, so the corpus has to exceed
// that before chunking has anything to split — 3 statements at --max-statements-per-request=1.
const LINKS = 801;

/** A work DB holding a small but complete related-persons corpus. */
function newWorkDb(dir) {
  const db = join(dir, 'work.sqlite');
  const links = Array.from(
    { length: LINKS },
    (_, i) =>
      `INSERT INTO interest_links(id,link_key,person_id,bidder_id,eik,entity_key,matcher_version,publish_tier,relation,status) VALUES('il${i}','p1|${i}','p1','eik:1','1','e','v1','B_distinctive','owns','published');`,
  ).join('\n');
  // Dot-commands like `.read` only work from a script/stdin, never as the SQL argument.
  execFileSync('sqlite3', ['-bail', db], {
    stdio: 'pipe',
    input: `PRAGMA foreign_keys=ON;
CREATE TABLE bidders(id TEXT PRIMARY KEY);
CREATE TABLE authorities(id TEXT PRIMARY KEY);
.read ${MIG}
INSERT INTO bidders(id) VALUES('eik:1');
INSERT INTO authorities(id) VALUES('auth:1');
INSERT INTO persons(id,name) VALUES('p1','П Тест');
INSERT INTO declarations(id,person_id,xml_file,folder_year,template,source_url) VALUES('d1','p1','x.xml','2024','assets','u');
INSERT INTO declared_interests(id,declaration_id,entity_raw,entity_key,kind) VALUES('di1','d1','E','e','shares');
${links}
INSERT INTO interest_link_authorities(link_key,authority_id,authority_name) VALUES('p1|0','auth:1','A');`,
  });
  return db;
}

/**
 * A `wrangler` that touches no network: it appends every invocation to a log and answers the
 * read-back UNION ALL query from a counts map, so the run can complete and be inspected.
 */
function fakeWrangler(dir, counts) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(dir, 'calls.jsonl');
  const exe = join(bin, 'wrangler');
  writeFileSync(
    exe,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const argv = process.argv.slice(2);
const at = (f) => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : null);
const file = at('--file');
const command = at('--command');
appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  file: file && file.split('/').pop(),
  sql: file ? readFileSync(file, 'utf8') : null,
  command,
}) + '\\n');
if (command) {
  const counts = ${JSON.stringify(counts)};
  const results = Object.entries(counts).map(([t, n]) => ({ t, n }));
  process.stdout.write('some wrangler notice\\n' + JSON.stringify([{ results }]));
}
`,
    { mode: 0o755 },
  );
  chmodSync(exe, 0o755);
  return { bin, readCalls: () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) };
}

function runShipScript(dir, counts, extraArgs = []) {
  const db = newWorkDb(dir);
  const { bin, readCalls } = fakeWrangler(dir, counts);
  const res = spawnSync(
    process.execPath,
    [
      SCRIPT,
      `--work-db=${db}`,
      '--local',
      '--min-links=1',
      '--max-statements-per-request=1',
      '--pace-ms=0',
      ...extraArgs,
    ],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  );
  return { res, calls: readCalls() };
}

const SHIPPED = {
  persons: 1,
  declarations: 1,
  declared_interests: 1,
  interest_links: LINKS,
  interest_link_authorities: 1,
};

test('the real ship run wipes first, chunks each table, and reads the counts back', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { res, calls } = runShipScript(dir, SHIPPED);
  assert.equal(res.status, 0, `ship failed:\n${res.stderr}`);

  const applies = calls.filter((c) => c.file);
  assert.match(applies[0].file, /^0_wipe\./, 'the wipe must be the first request');
  for (const table of TABLES)
    assert.ok(
      applies.some((c) => c.file.startsWith(`${table}.`)),
      `${table} was never shipped`,
    );

  // THE guarantee: a multi-statement table must arrive as several NUMBERED requests, not one bulk
  // shot. One request per table is the shape that caused the incident this change exists to prevent.
  const linkRequests = applies.filter((c) => /^interest_links\.\d+\./.test(c.file));
  assert.equal(
    linkRequests.length,
    3,
    `${LINKS} rows must ship as 3 numbered requests, got ${JSON.stringify(applies.map((c) => c.file))}`,
  );

  // THE other guarantee: the run must ask the target what it actually holds.
  const readBack = calls.filter((c) => c.command);
  assert.equal(readBack.length, 1, 'exactly one read-back query');
  for (const table of TABLES)
    assert.match(
      readBack[0].command,
      new RegExp(`COUNT\\(\\*\\).*${table}`),
      `${table} unverified`,
    );
});

test('the real ship run fails when the target came up short', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-e2e-short-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { res } = runShipScript(dir, { ...SHIPPED, interest_links: LINKS - 1 });
  assert.notEqual(res.status, 0, 'a short target must fail the run');
  assert.match(res.stderr, /ship verification FAILED/);
  assert.match(res.stderr, new RegExp(`interest_links: shipped ${LINKS}, target has ${LINKS - 1}`));
});
