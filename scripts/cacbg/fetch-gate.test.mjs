// Integration test for the crawl COMPLETENESS GATE (#226, Todor #2). The pure decision (assessCompleteness)
// is unit-tested in fetch.test.mjs; this exercises the real run() end to end and asserts the exit code it
// yields for each crawl outcome. getPinned hard-refuses any host but register.cacbg.bg, so a fake HTTP server
// is impossible — run() takes its I/O boundary (httpGet, rawDir, argv, guard) injectable, and we drive it with
// a fake getter + a temp raw dir so no network, TLS, or real scratch is touched. The final case runs the whole
// thing in a SUBPROCESS to prove the returned code becomes a real non-zero process exit (the wiring, not just
// the decision).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './fetch.mjs';

const BASE = 'https://register.cacbg.bg';
const FOLDER = '2099t'; // passes safeFolder (starts with 20YY); not a real register set

// A minimal list.xml the real parseList accepts: xmlFile is a child element, so parser attribute config is
// irrelevant. One <Declaration> per file name.
const listXml = (files) =>
  `<root><MainCategory><Category Name="C"><Institution Name="I"><Person><Name>N</Name>` +
  `<Position><Name>P</Name>` +
  files.map((f) => `<Declaration><xmlFile>${f}</xmlFile></Declaration>`).join('') +
  `</Position></Person></Institution></Category></MainCategory></root>`;

// Build a fake get-with-retries from a URL→{status,body} map. An unmapped URL resolves to 404 (a source gap),
// matching how the register answers a listed-but-unpublished declaration.
const fakeGet = (routes) => async (url) => {
  const r = routes[url];
  return r
    ? { status: r.status, headers: {}, body: Buffer.from(r.body ?? '', 'utf8') }
    : { status: 404, headers: {}, body: Buffer.from('') };
};

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-gate-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const runGate = (routes, extraArgv = []) =>
  run({
    httpGet: fakeGet(routes),
    rawDir: dir,
    guard: () => {}, // the scratch-ignored guard protects the real scratch; irrelevant to a temp rawDir
    argv: ['node', 'fetch.mjs', '--folders', FOLDER, '--concurrency', '1', ...extraArgv],
  });

const list2 = {
  [`${BASE}/${FOLDER}/list.xml`]: { status: 200, body: listXml(['a1.xml', 'a2.xml']) },
};
const ok = (f) => ({ [`${BASE}/${FOLDER}/${f}`]: { status: 200, body: '<x/>' } });

test('complete crawl (every announced declaration 200) → exit 0', async () => {
  assert.equal(await runGate({ ...list2, ...ok('a1.xml'), ...ok('a2.xml') }), 0);
});

test('a 404 declaration is a source gap (listed-but-unpublished), not a shortfall → exit 0', async () => {
  // a2.xml unmapped → fake returns 404
  assert.equal(await runGate({ ...list2, ...ok('a1.xml') }), 0);
});

test('a non-404 miss (500 after retries) is a real shortfall → exit 1', async () => {
  const routes = {
    ...list2,
    ...ok('a1.xml'),
    [`${BASE}/${FOLDER}/a2.xml`]: { status: 500, body: '' },
  };
  assert.equal(await runGate(routes), 1);
});

test('a wholesale-skipped set (list.xml non-200) → exit 1', async () => {
  assert.equal(await runGate({ [`${BASE}/${FOLDER}/list.xml`]: { status: 503, body: '' } }), 1);
});

test('--allow-incomplete downgrades a shortfall to a warning → exit 0', async () => {
  const routes = {
    ...list2,
    ...ok('a1.xml'),
    [`${BASE}/${FOLDER}/a2.xml`]: { status: 500, body: '' },
  };
  assert.equal(await runGate(routes, ['--allow-incomplete']), 0);
});

// --- the deadline (run 31889519937): the crawl must stop ITSELF before a CI job cap kills it mid-write ---
// The clock is injected and driven by the fake getter — one tick per HTTP request — so „when" the deadline
// falls is expressed in requests, not in real elapsed time, and the tests are deterministic.
const tickingGate = (
  routes,
  msPerRequest,
  extraArgv = [],
  folders = [FOLDER],
  concurrency = '1',
) => {
  let clock = 0;
  const routed = fakeGet(routes);
  return run({
    httpGet: async (url) => {
      clock += msPerRequest;
      return routed(url);
    },
    rawDir: dir,
    guard: () => {},
    now: () => clock,
    argv: [
      'node',
      'fetch.mjs',
      '--folders',
      folders.join(','),
      '--concurrency',
      concurrency,
      '--deadline-minutes',
      '1',
      ...extraArgv,
    ],
  });
};

// The case assessCompleteness CANNOT see. Every set the crawl reached is fully obtained, so the arithmetic
// says „complete" — while whole later years were never opened. Without a deadline term in the gate this
// exits 0 and the pipeline ships a corpus missing entire years.
test('deadline on a set boundary → later sets are never attempted, and the gate still refuses (exit 1)', async () => {
  const FOLDER2 = '2098t';
  const routes = {
    ...list2,
    ...ok('a1.xml'),
    ...ok('a2.xml'),
    [`${BASE}/${FOLDER2}/list.xml`]: { status: 200, body: listXml(['b1.xml']) },
    [`${BASE}/${FOLDER2}/b1.xml`]: { status: 200, body: '<x/>' },
  };
  // 3 requests fit in the first set (list.xml + a1 + a2); at 25 s each the clock reads 75 s > 60 s when the
  // set closes, so the second set is refused at the top of the loop.
  const code = await tickingGate(routes, 25_000, [], [FOLDER, FOLDER2]);
  assert.equal(code, 1, 'a deadline stop must never certify the corpus');
  assert.ok(fs.existsSync(path.join(dir, FOLDER, 'a2.xml')), 'the first set completed');
  assert.equal(
    fs.existsSync(path.join(dir, FOLDER2)),
    false,
    'an out-of-budget set must leave no directory — an empty one reads like a visited set',
  );
});

// A set whose list.xml never loads is `continue`d, which bypasses the end-of-set check — so the budget has
// to be tested at the TOP of the loop too, or a run of unavailable sets crawls straight through it.
// --allow-incomplete is passed deliberately: a skipped set makes the corpus incomplete on the ORDINARY gate
// too, so without the override this test would pass on that alone and say nothing about the deadline.
test('a set skipped on list.xml still consumes the budget — the next set is refused (exit 1)', async () => {
  const FOLDER2 = '2098t';
  const routes = {
    [`${BASE}/${FOLDER}/list.xml`]: { status: 503, body: '' },
    [`${BASE}/${FOLDER2}/list.xml`]: { status: 200, body: listXml(['b1.xml']) },
    [`${BASE}/${FOLDER2}/b1.xml`]: { status: 200, body: '<x/>' },
  };
  const code = await tickingGate(routes, 61_000, ['--allow-incomplete'], [FOLDER, FOLDER2]);
  assert.equal(code, 1, 'only the deadline term can produce this exit code');
  assert.equal(
    fs.existsSync(path.join(dir, FOLDER2)),
    false,
    'the budget was spent on the skipped set; the next one must not be opened',
  );
});

// The regression that the independent review caught (finding 2). A set whose LAST in-flight request lands
// past the budget withheld NOTHING — every announced declaration is on disk. Inferring the stop from the
// clock instead of from the pool condemned exactly the run that finally completed the corpus: exit 1,
// extract/ship skipped, four hours red for a job that had actually succeeded.
test('a fully-obtained corpus whose last request crosses the deadline is COMPLETE (exit 0)', async () => {
  // 31 s per request: list.xml at 31 s (under), a1.xml at 62 s (over) — and a1 was the only announced row.
  const routes = {
    [`${BASE}/${FOLDER}/list.xml`]: { status: 200, body: listXml(['a1.xml']) },
    ...ok('a1.xml'),
  };
  const code = await tickingGate(routes, 31_000);
  assert.equal(fs.existsSync(path.join(dir, FOLDER, 'a1.xml')), true, 'nothing was withheld');
  assert.equal(code, 0, 'a complete corpus must never be reported as a deadline stop');
});

// Every other deadline test runs one worker, which cannot see a stop condition that only SOME workers
// honour. Production runs eight. With the budget spent before any declaration is handed out, a pool where
// even one worker ignores `shouldStop` writes into the very window the deadline reserves for tar.
test('the deadline binds EVERY worker, not just the first (concurrency 8)', async () => {
  const files = Array.from({ length: 24 }, (_, i) => `c${i}.xml`);
  const routes = {
    [`${BASE}/${FOLDER}/list.xml`]: { status: 200, body: listXml(files) },
    ...Object.assign({}, ...files.map((f) => ok(f))),
  };
  const code = await tickingGate(routes, 61_000, [], [FOLDER], '8');
  assert.equal(code, 1);
  const written = files.filter((f) => fs.existsSync(path.join(dir, FOLDER, f)));
  assert.deepEqual(written, [], `no worker may fetch past the budget, got ${written.join(', ')}`);
});

// An entry-only deadline check passes every worker while the budget remains, then lets those workers drain
// the folder after it expires. The clock must fall mid-folder, with both written and still-unhanded rows, to
// distinguish that bug from a per-item check at production concurrency.
test('deadline falls MID-folder at concurrency 8 → later rows stay unfetched (exit 1)', async () => {
  const files = Array.from({ length: 24 }, (_, i) => `c${i}.xml`);
  const routes = {
    [`${BASE}/${FOLDER}/list.xml`]: { status: 200, body: listXml(files) },
    ...Object.assign({}, ...files.map((f) => ok(f))),
  };
  // list.xml leaves 50 s of the 60 s budget, so workers enter the pool before later requests spend it.
  const code = await tickingGate(routes, 10_000, [], [FOLDER], '8');
  const written = files.filter((f) => fs.existsSync(path.join(dir, FOLDER, f)));
  assert.ok(written.length > 0, 'the deadline must fall after declaration work starts');
  assert.ok(
    written.length < files.length,
    `the pool must withhold rows once the budget is spent — it wrote all ${files.length}`,
  );
  assert.equal(code, 1, 'a mid-folder deadline stop is a partial corpus and must exit 1');
});

// The comparison is `>=`, so a clock landing EXACTLY on the budget is spent, not still running. Off-by-one
// here is invisible to every other test, which all land clear of the boundary.
test('a clock landing exactly on the deadline is spent (exit 1)', async () => {
  const FOLDER2 = '2098t';
  const routes = {
    [`${BASE}/${FOLDER}/list.xml`]: { status: 200, body: listXml(['a1.xml']) },
    ...ok('a1.xml'),
    [`${BASE}/${FOLDER2}/list.xml`]: { status: 200, body: listXml(['b1.xml']) },
    [`${BASE}/${FOLDER2}/b1.xml`]: { status: 200, body: '<x/>' },
  };
  // 2 requests close the first set at exactly 60 000 ms — the budget, to the millisecond.
  const code = await tickingGate(routes, 30_000, ['--allow-incomplete'], [FOLDER, FOLDER2]);
  assert.equal(code, 1);
  assert.equal(fs.existsSync(path.join(dir, FOLDER2)), false, 'exactly-spent is spent');
});

test('deadline inside a set → the remaining declarations stay unfetched (exit 1)', async () => {
  // 61 s per request: the clock is past the deadline the moment list.xml lands, so no declaration is handed
  // out at all and the raw tree holds only the list.
  const code = await tickingGate({ ...list2, ...ok('a1.xml'), ...ok('a2.xml') }, 61_000);
  assert.equal(code, 1);
  assert.equal(fs.existsSync(path.join(dir, FOLDER, 'list.xml')), true);
  assert.equal(
    fs.existsSync(path.join(dir, FOLDER, 'a1.xml')),
    false,
    'pool stopped handing out work',
  );
});

// --allow-incomplete means „I have seen this shortfall and accept it". A deadline is a clock going off with
// nobody having looked, so it must not be downgradable — otherwise the workflow's own flag could publish a
// half-crawled corpus.
test('--allow-incomplete does NOT downgrade a deadline stop (still exit 1)', async () => {
  // One remaining row equals the worker count. A pool that claims the row before checking the deadline
  // mistakes an exhausted cursor for completed work, so the ordinary incomplete override wrongly exits 0.
  const routes = {
    [`${BASE}/${FOLDER}/list.xml`]: { status: 200, body: listXml(['a1.xml']) },
    ...ok('a1.xml'),
  };
  const code = await tickingGate(routes, 61_000, ['--allow-incomplete']);
  assert.equal(code, 1);
});

// Regression guard: the deadline is opt-in. Without the flag a complete crawl still exits 0 — and with a
// budget that is never reached, the crawl runs to the end.
test('a deadline that is never reached leaves the crawl untouched (exit 0)', async () => {
  const code = await tickingGate({ ...list2, ...ok('a1.xml'), ...ok('a2.xml') }, 1_000);
  assert.equal(code, 0);
  assert.equal(fs.existsSync(path.join(dir, FOLDER, 'a2.xml')), true);
});

// Prove the RETURNED code becomes a real non-zero PROCESS exit (run() → process.exitCode, the production
// wiring), in a real subprocess driving the real run() with the injected fake.
test('the process actually exits non-zero on an incomplete crawl (and zero on a complete one)', () => {
  const fetchHref = new URL('./fetch.mjs', import.meta.url).href;
  const harness = (routes) =>
    `import { run } from ${JSON.stringify(fetchHref)};\n` +
    `const routes = ${JSON.stringify(routes)};\n` +
    `const httpGet = async (url) => { const r = routes[url]; return r ? { status: r.status, headers: {}, body: Buffer.from(r.body ?? '', 'utf8') } : { status: 404, headers: {}, body: Buffer.from('') }; };\n` +
    `run({ httpGet, rawDir: ${JSON.stringify(dir)}, guard: () => {}, argv: ['node','fetch.mjs','--folders',${JSON.stringify(FOLDER)},'--concurrency','1'] })\n` +
    `  .then((code) => { process.exitCode = code; })\n` +
    `  .catch((e) => { console.error(e); process.exit(2); });\n`;
  const spawn = (routes) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', harness(routes)], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      encoding: 'utf8',
    });

  const incomplete = spawn({ [`${BASE}/${FOLDER}/list.xml`]: { status: 503, body: '' } });
  assert.equal(incomplete.status, 1, incomplete.stderr);

  const complete = spawn({ ...list2, ...ok('a1.xml'), ...ok('a2.xml') });
  assert.equal(complete.status, 0, complete.stderr);
});
