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
