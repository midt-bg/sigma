// The completeness sentinel — the one signal that tells a PARTIAL raw corpus apart from a whole one.
//
// #313 made a partial corpus an EXPECTED state: the crawl now stops on its deadline and saves what it has,
// which is what lets a cold corpus finish across two runs. But `restore-keys: cacbg-raw-` returns the most
// RECENT snapshot, not the most complete, and extract.mjs walks readdirSync over whatever files exist
// without reconciling them against the register's own list.xml. So before this, a truncated corpus simply
// produced a smaller published surface with no error anywhere — and neither downstream gate closes it: the
// monotonicity gate sees net growth whenever new links outnumber lost ones, the --min-links floor only
// counts, and a first run in a fresh environment has no baseline at all.
//
// These tests pin the two halves that have to agree: the crawl stamps ONLY a corpus that reconciled, and
// the extractor refuses one that carries no stamp.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { run, sentinelPath } from './fetch.mjs';

const BASE = 'https://register.cacbg.bg';
const FOLDER = '2099t';

const listXml = (files) =>
  `<root><MainCategory><Category Name="C"><Institution Name="I"><Person><Name>N</Name>` +
  `<Position><Name>P</Name>` +
  files.map((f) => `<Declaration><xmlFile>${f}</xmlFile></Declaration>`).join('') +
  `</Position></Person></Institution></Category></MainCategory></root>`;

const fakeGet = (routes) => async (url) => {
  const r = routes[url];
  return r
    ? { status: r.status, headers: {}, body: Buffer.from(r.body ?? '', 'utf8') }
    : { status: 404, headers: {}, body: Buffer.from('') };
};

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-sentinel-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ok = (f) => ({ [`${BASE}/${FOLDER}/${f}`]: { status: 200, body: '<x/>' } });
const crawl = (routes, extraArgv = [], msPerRequest = null) => {
  let clock = 0;
  const routed = fakeGet(routes);
  return run({
    httpGet: msPerRequest
      ? async (url) => {
          clock += msPerRequest;
          return routed(url);
        }
      : routed,
    rawDir: dir,
    guard: () => {},
    ...(msPerRequest ? { now: () => clock } : {}),
    argv: ['node', 'fetch.mjs', '--folders', FOLDER, '--concurrency', '1', ...extraArgv],
  });
};

test('a corpus that reconciles against list.xml is stamped', async () => {
  const routes = {
    [`${BASE}/${FOLDER}/list.xml`]: { status: 200, body: listXml(['a1.xml', 'a2.xml']) },
    ...ok('a1.xml'),
    ...ok('a2.xml'),
  };
  assert.equal(await crawl(routes), 0);
  assert.equal(fs.existsSync(sentinelPath(dir)), true, 'a whole corpus must be publishable');
  const stamp = JSON.parse(fs.readFileSync(sentinelPath(dir), 'utf8'));
  assert.equal(stamp.incomplete, false);
  assert.ok(stamp.stampedAt, 'the stamp records WHEN, so a stale one is recognisable');
});

test('a deadline stop leaves the corpus UNSTAMPED — resumable, but not publishable', async () => {
  // The exact state #313 introduced and made routine. The raw cache is intact and the next crawl resumes
  // from it; what must not happen is a later no-crawl run publishing from it as though it were whole.
  const routes = {
    [`${BASE}/${FOLDER}/list.xml`]: { status: 200, body: listXml(['a1.xml', 'a2.xml']) },
    ...ok('a1.xml'),
    ...ok('a2.xml'),
  };
  assert.equal(
    await crawl(routes, ['--deadline-minutes', '1'], 61_000),
    1,
    'a deadline stop still exits non-zero',
  );
  assert.equal(
    fs.existsSync(sentinelPath(dir)),
    false,
    'a deadline-stopped corpus must NOT carry a completeness stamp',
  );
});

test('an incomplete corpus is unstamped even under --allow-incomplete', async () => {
  // --allow-incomplete records that an operator SAW this shortfall and accepted it. That acceptance is
  // theirs and does not travel: a later unattended run restoring this cache must not inherit it as whole.
  const routes = {
    [`${BASE}/${FOLDER}/list.xml`]: { status: 200, body: listXml(['a1.xml', 'a2.xml']) },
    ...ok('a1.xml'),
    [`${BASE}/${FOLDER}/a2.xml`]: { status: 500, body: '' },
  };
  assert.equal(
    await crawl(routes, ['--allow-incomplete']),
    0,
    'the flag still lets the run proceed',
  );
  assert.equal(
    fs.existsSync(sentinelPath(dir)),
    false,
    'but the corpus stays unstamped — the acceptance was for THIS run only',
  );
});

test('a stale stamp cannot outlive the corpus it described', async () => {
  // Stamp first, then run a crawl that fails. If the stamp were only WRITTEN and never CLEARED, the failed
  // run would inherit the previous run's verdict — the precise shape of every "the marker lied" bug here.
  fs.writeFileSync(
    sentinelPath(dir),
    JSON.stringify({ incomplete: false, stampedAt: 'yesterday' }),
  );
  const routes = {
    [`${BASE}/${FOLDER}/list.xml`]: { status: 200, body: listXml(['a1.xml', 'a2.xml']) },
    ...ok('a1.xml'),
    [`${BASE}/${FOLDER}/a2.xml`]: { status: 500, body: '' },
  };
  assert.equal(await crawl(routes), 1);
  assert.equal(
    fs.existsSync(sentinelPath(dir)),
    false,
    'the prior stamp must be gone — cleared before fetching, rewritten only on a clean exit',
  );
});

// ── the reading half ───────────────────────────────────────────────────────────────────────────────
// The writer above is only useful if something refuses an unstamped corpus. extract.mjs is that reader,
// and it runs in-process, so it is exercised as a subprocess against a temp scratch tree.

test('extract refuses an unstamped corpus, and says how to proceed', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-extract-'));
  fs.mkdirSync(path.join(scratch, 'raw', FOLDER), { recursive: true });
  const res = spawnSync(process.execPath, [path.resolve('scripts/cacbg/extract.mjs')], {
    env: {
      ...process.env,
      CACBG_RAW: path.join(scratch, 'raw'),
      CACBG_STAGING: path.join(scratch, 'staging'),
    },
    encoding: 'utf8',
  });
  assert.notEqual(res.status, 0, 'an unstamped corpus must not extract');
  const out = `${res.stdout}${res.stderr}`;
  assert.match(out, /REFUSE TO EXTRACT/);
  assert.match(out, /--allow-partial-corpus/, 'the refusal must name the deliberate override');
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('extract proceeds on a stamped corpus', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-extract-ok-'));
  fs.mkdirSync(path.join(scratch, 'raw', FOLDER), { recursive: true });
  fs.writeFileSync(
    path.join(scratch, 'raw', '.corpus-complete.json'),
    JSON.stringify({ incomplete: false, stampedAt: new Date().toISOString() }),
  );
  const res = spawnSync(process.execPath, [path.resolve('scripts/cacbg/extract.mjs')], {
    env: {
      ...process.env,
      CACBG_RAW: path.join(scratch, 'raw'),
      CACBG_STAGING: path.join(scratch, 'staging'),
    },
    encoding: 'utf8',
  });
  const out = `${res.stdout}${res.stderr}`;
  assert.doesNotMatch(out, /REFUSE TO EXTRACT/, 'a stamped corpus must pass the gate');
  fs.rmSync(scratch, { recursive: true, force: true });
});
