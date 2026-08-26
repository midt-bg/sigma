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

const ok = (f, folder = FOLDER) => ({ [`${BASE}/${folder}/${f}`]: { status: 200, body: '<x/>' } });
// Discovery-mode by default: the stamp is deliberately reserved for full-discovery crawls, so the tests
// that expect one must crawl the way the workflow does. `folders` switches to a --folders subset run.
const crawl = (
  routes,
  extraArgv = [],
  msPerRequest = null,
  { discovered = [FOLDER], folders = null } = {},
) => {
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
    discover: async () => discovered,
    ...(msPerRequest ? { now: () => clock } : {}),
    argv: [
      'node',
      'fetch.mjs',
      ...(folders ? ['--folders', folders] : []),
      '--concurrency',
      '1',
      ...extraArgv,
    ],
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

test('a --folders subset that completes does NOT stamp — complete for the subset is not complete', async () => {
  // Review finding (blocker): raw/ holds another folder in unknown state; certifying the whole tree off
  // one finished subset would stamp around it. The subset still CLEARS any prior stamp (it mutates the
  // corpus), leaving resumable-not-publishable — the correct state.
  const OTHER = '2098t';
  fs.mkdirSync(path.join(dir, OTHER), { recursive: true });
  fs.writeFileSync(path.join(dir, OTHER, 'stale.xml'), '<x/>');
  // Seeded stamp: the subset must CLEAR it (it mutates the corpus), not merely decline to write one —
  // a clear that runs only on the discovery path would leave this stale certificate standing.
  fs.writeFileSync(
    sentinelPath(dir),
    JSON.stringify({ incomplete: false, stampedAt: 'yesterday' }),
  );
  const routes = {
    [`${BASE}/${FOLDER}/list.xml`]: { status: 200, body: listXml(['a1.xml']) },
    ...ok('a1.xml'),
  };
  assert.equal(await crawl(routes, [], null, { folders: FOLDER }), 0, 'the subset itself succeeds');
  assert.equal(
    fs.existsSync(sentinelPath(dir)),
    false,
    'a subset run must never certify the whole corpus — and must clear a prior certificate',
  );
});

test('an index that discovers ZERO folders is a failure, not a trivially complete corpus', async () => {
  // Review finding (blocker, reproduced): exit 0 and a `folders: 0, incomplete: false` stamp over an
  // existing raw tree. The register has published year-sets continuously since 2015 — an empty index is
  // a broken or redesigned index page, never a real corpus state.
  fs.mkdirSync(path.join(dir, FOLDER), { recursive: true });
  fs.writeFileSync(path.join(dir, FOLDER, 'a1.xml'), '<x/>');
  // Seeded stamp: the clear must run BEFORE the zero-discovery bail-out, or the failure exits 1 while
  // yesterday's certificate keeps standing over a tree the run just declared unverifiable.
  fs.writeFileSync(
    sentinelPath(dir),
    JSON.stringify({ incomplete: false, stampedAt: 'yesterday' }),
  );
  assert.equal(await crawl({}, [], null, { discovered: [] }), 1);
  assert.equal(fs.existsSync(sentinelPath(dir)), false, 'the stale stamp must be gone too');
});

test('a maintenance page on a FRESH folder cannot ride a valid neighbour into a stamp', async () => {
  // The review reproduced exactly this: folder A serves maintenance HTML (0 rows, no files on disk),
  // folder B is valid — skippedSets stayed 0, the corpus stamped. Zero-row folders now skip
  // unconditionally, so A makes the corpus incomplete regardless of B.
  const A = '2097t';
  const routes = {
    [`${BASE}/${A}/list.xml`]: { status: 200, body: '<html>maintenance</html>' },
    [`${BASE}/${FOLDER}/list.xml`]: { status: 200, body: listXml(['a1.xml']) },
    ...ok('a1.xml'),
  };
  assert.equal(await crawl(routes, [], null, { discovered: [A, FOLDER] }), 1);
  assert.equal(fs.existsSync(sentinelPath(dir)), false);
});

test('a 200 list.xml that parses to zero rows over existing declarations is a skip, not an empty set', async () => {
  // Review finding: a maintenance HTML page and a schema change both come back 200 and parse to [].
  // Trusting one would zero out `announced`, make the folder look complete, and overwrite the cached
  // list the extractor reads. With files on disk contradicting it, the folder is skipped — which makes
  // the corpus incomplete: exit 1, no stamp, cached list.xml preserved.
  fs.mkdirSync(path.join(dir, FOLDER), { recursive: true });
  fs.writeFileSync(path.join(dir, FOLDER, 'a1.xml'), '<x/>');
  fs.writeFileSync(path.join(dir, FOLDER, 'list.xml'), listXml(['a1.xml']));
  const routes = {
    [`${BASE}/${FOLDER}/list.xml`]: { status: 200, body: '<html>maintenance</html>' },
  };
  assert.equal(await crawl(routes), 1);
  assert.equal(fs.existsSync(sentinelPath(dir)), false);
  assert.match(
    fs.readFileSync(path.join(dir, FOLDER, 'list.xml'), 'utf8'),
    /a1\.xml/,
    'the cached list the extractor reads must not be overwritten by the contradicted body',
  );
});

test('a truncated list whose tail still parses to one row is malformed, not a one-row set', async () => {
  // Review round 3 (blocker, reproduced): lenient parsing accepted a mangled body's surviving complete
  // <Declaration> as the whole announcement — announced 1, reconciled, STAMPED. Structural validation
  // now precedes counting: not-well-formed ⇒ the folder is skipped and the corpus cannot certify.
  const truncated =
    `<root><MainCategory><Category Name="C"><Institution Name="I"><Person><Name>N</Name>` +
    `<Position><Name>P</Name><Declaration><xmlFile>a1.xml</xmlFile></Declaration><Declaration><xmlFile>a2`;
  const routes = {
    [`${BASE}/${FOLDER}/list.xml`]: { status: 200, body: truncated },
    ...ok('a1.xml'),
  };
  assert.equal(await crawl(routes), 1);
  assert.equal(fs.existsSync(sentinelPath(dir)), false);
});

test('a list that announces fewer rows than the cached one is a contradiction, not an update', async () => {
  // Review round 3 (blocker, reproduced): cached [a1,a2], incoming [a1] — the fuller cache was
  // overwritten and the shrunken corpus stamped. The resume design rests on per-year immutability, so
  // shrinkage is skipped and the cached list survives; a genuine withdrawal is a human decision on a
  // red run, not a certifier's.
  fs.mkdirSync(path.join(dir, FOLDER), { recursive: true });
  fs.writeFileSync(path.join(dir, FOLDER, 'list.xml'), listXml(['a1.xml', 'a2.xml']));
  fs.writeFileSync(path.join(dir, FOLDER, 'a1.xml'), '<x/>');
  fs.writeFileSync(path.join(dir, FOLDER, 'a2.xml'), '<x/>');
  const routes = {
    [`${BASE}/${FOLDER}/list.xml`]: { status: 200, body: listXml(['a1.xml']) },
    ...ok('a1.xml'),
  };
  assert.equal(await crawl(routes), 1);
  assert.equal(fs.existsSync(sentinelPath(dir)), false);
  assert.match(
    fs.readFileSync(path.join(dir, FOLDER, 'list.xml'), 'utf8'),
    /a2\.xml/,
    'the fuller cached list must survive the contradicted shrinkage',
  );
});

test('a multi-root body that validates is still not a list', async () => {
  // Round 4 (blocker, reproduced): fast-xml-parser validates `<wrong/><root>…</root>` as true, and the
  // lenient parser merges both roots so parseList still finds the rows. Exactly one document element or
  // the folder is skipped.
  const multi = `<wrong/>` + listXml(['a1.xml']);
  const routes = {
    [`${BASE}/${FOLDER}/list.xml`]: { status: 200, body: multi },
    ...ok('a1.xml'),
  };
  assert.equal(await crawl(routes), 1);
  assert.equal(fs.existsSync(sentinelPath(dir)), false);
});

test('a corrupt cached list is healed by a valid incoming one, not crashed on', async () => {
  // Round 4 (minor, recovered from the truncated report): the shrink check parses the CACHED list, and
  // a legacy/corrupt body there threw instead of letting the valid incoming list replace it. The
  // sentinel was already cleared, so it was fail-closed — but self-healing is the designed behavior.
  fs.mkdirSync(path.join(dir, FOLDER), { recursive: true });
  fs.writeFileSync(path.join(dir, FOLDER, 'list.xml'), '<!DOCTYPE nonsense><<<broken');
  const routes = {
    [`${BASE}/${FOLDER}/list.xml`]: { status: 200, body: listXml(['a1.xml']) },
    ...ok('a1.xml'),
  };
  assert.equal(await crawl(routes), 0, 'the valid incoming list must heal the corrupt cache');
  assert.equal(fs.existsSync(sentinelPath(dir)), true);
  assert.match(fs.readFileSync(path.join(dir, FOLDER, 'list.xml'), 'utf8'), /a1\.xml/);
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
  assert.equal(
    res.status,
    0,
    `a stamped corpus must extract cleanly, got ${res.status}: ${out.slice(0, 300)}`,
  );
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('--allow-partial-corpus extracts an unstamped corpus, loudly', () => {
  // The deliberate override the refusal names. Without a test, deleting the flag entirely would leave
  // every test green while the documented escape hatch silently stopped existing (review finding).
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-extract-partial-'));
  fs.mkdirSync(path.join(scratch, 'raw', FOLDER), { recursive: true });
  const res = spawnSync(
    process.execPath,
    [path.resolve('scripts/cacbg/extract.mjs'), '--allow-partial-corpus'],
    {
      env: {
        ...process.env,
        CACBG_RAW: path.join(scratch, 'raw'),
        CACBG_STAGING: path.join(scratch, 'staging'),
      },
      encoding: 'utf8',
    },
  );
  const out = `${res.stdout}${res.stderr}`;
  assert.equal(
    res.status,
    0,
    `the override must let the run proceed, got ${res.status}: ${out.slice(0, 300)}`,
  );
  assert.match(out, /--allow-partial-corpus/, 'the acceptance must be printed, never silent');
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('a CACBG_STAGING override pointing at a tracked path inside the repo is refused', () => {
  // Review finding: the env seams redirect real I/O, and assertScratchIgnored only probes the fixed
  // scratch/ location — so an override could write related.jsonl (third-party names) into a directory
  // git would commit. The override rail applies the same rule scratch/ satisfies: inside the repo ⇒
  // must be git-ignored.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-extract-pii-'));
  fs.mkdirSync(path.join(scratch, 'raw'), { recursive: true });
  const res = spawnSync(process.execPath, [path.resolve('scripts/cacbg/extract.mjs')], {
    env: {
      ...process.env,
      CACBG_RAW: path.join(scratch, 'raw'),
      CACBG_STAGING: path.resolve('scripts', 'pii-leak-probe'), // inside the repo, NOT ignored
    },
    encoding: 'utf8',
  });
  const out = `${res.stdout}${res.stderr}`;
  assert.notEqual(res.status, 0, 'a committable PII destination must refuse to run');
  assert.match(out, /CACBG_STAGING/, 'the refusal must name the offending variable');
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('a CACBG_RAW override pointing at a tracked path inside the repo is refused too', () => {
  // Same rail, other variable — deleting only the RAW validation survived the STAGING-only test.
  const res = spawnSync(process.execPath, [path.resolve('scripts/cacbg/extract.mjs')], {
    env: {
      ...process.env,
      CACBG_RAW: path.resolve('scripts', 'pii-raw-probe'),
      CACBG_STAGING: fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-pii-raw-')),
    },
    encoding: 'utf8',
  });
  const out = `${res.stdout}${res.stderr}`;
  assert.notEqual(res.status, 0);
  assert.match(out, /CACBG_RAW/, 'the refusal must name the offending variable');
});

// ── the override guard, adversarially ──────────────────────────────────────────────────────────────
// Round-3 findings: the guard must answer for the FILESYSTEM location (not an inherited GIT_DIR), must
// check EVERY containing worktree (not just the innermost), and an unanswerable question fails closed.

test('an inherited GIT_DIR cannot substitute a permissive repository for the real one', () => {
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-decoy-'));
  spawnSync('git', ['init', '-q', decoy], { encoding: 'utf8' });
  fs.mkdirSync(path.join(decoy, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(decoy, '.git', 'info', 'exclude'), '*\n'); // decoy ignores EVERYTHING
  const res = spawnSync(process.execPath, [path.resolve('scripts/cacbg/extract.mjs')], {
    env: {
      ...process.env,
      GIT_DIR: path.join(decoy, '.git'),
      GIT_WORK_TREE: path.resolve('.'),
      CACBG_RAW: fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-git-raw-')),
      CACBG_STAGING: path.resolve('scripts', 'pii-leak-probe'),
    },
    encoding: 'utf8',
  });
  const out = `${res.stdout}${res.stderr}`;
  assert.notEqual(res.status, 0, 'the decoy exclude-everything repo must not be consulted');
  assert.match(out, /does not ignore/);
  fs.rmSync(decoy, { recursive: true, force: true });
});

test('a nested repository that ignores the path does not clear an OUTER repository that tracks it', () => {
  // The committable leak from review round 3: the file entered the OUTER index BEFORE the nested repo
  // existed. Tracked beats ignored — ignore rules never apply to the index, and the nested repo's
  // implicit ignore silently covers it. (A nested repo with nothing tracked outside is genuinely
  // uncommittable from the outer side — git add refuses across the boundary — and passes.)
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-outer-'));
  spawnSync('git', ['init', '-q', outer], { encoding: 'utf8' });
  const inner = path.join(outer, 'inner');
  fs.mkdirSync(path.join(inner, 'sink'), { recursive: true });
  fs.writeFileSync(path.join(inner, 'sink', 'related.jsonl'), '{}\n');
  spawnSync('git', ['add', 'inner/sink/related.jsonl'], { cwd: outer, encoding: 'utf8' }); // tracked FIRST
  spawnSync('git', ['init', '-q', inner], { encoding: 'utf8' }); // nested repo appears AFTER
  fs.writeFileSync(path.join(inner, '.gitignore'), 'sink/\n'); // inner ignores it; outer index unmoved
  const res = spawnSync(process.execPath, [path.resolve('scripts/cacbg/extract.mjs')], {
    env: {
      ...process.env,
      CACBG_RAW: fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-nest-raw-')),
      CACBG_STAGING: path.join(inner, 'sink'),
    },
    encoding: 'utf8',
  });
  const out = `${res.stdout}${res.stderr}`;
  assert.notEqual(res.status, 0, 'the outer worktree still tracks inner/sink');
  assert.match(out, /TRACKED/, 'the refusal must name the real reason — the index, not a pattern');
  fs.rmSync(outer, { recursive: true, force: true });
});

test('when git cannot answer at all, the guard fails closed', () => {
  // Round 3: EPERM, a missing git and a corrupt repository all used to PASS. Only a confirmed
  // "not a repository" may pass; an unanswered safety question refuses.
  const res = spawnSync(process.execPath, [path.resolve('scripts/cacbg/extract.mjs')], {
    env: {
      HOME: process.env.HOME,
      PATH: '/nonexistent', // git unreachable
      CACBG_RAW: fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-nogit-raw-')),
      CACBG_STAGING: fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-nogit-stg-')),
    },
    encoding: 'utf8',
  });
  const out = `${res.stdout}${res.stderr}`;
  assert.notEqual(res.status, 0, 'no verification means no run');
  assert.match(out, /could not be verified/);
});

test('a literal directory named like pathspec magic cannot resolve to an ignored path', () => {
  // Round 4 (blocker, verified): `--` does not disable pathspec magic, and check-ignore evaluates
  // `:(top)…` — a directory LITERALLY named `:(top)scratch/cacbg/leak` used to be judged by the ignore
  // status of scratch/cacbg/leak and pass, while the literal directory is committable. The ./ prefix
  // keeps the name a name.
  const res = spawnSync(process.execPath, [path.resolve('scripts/cacbg/extract.mjs')], {
    env: {
      ...process.env,
      CACBG_RAW: fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-magic-raw-')),
      CACBG_STAGING: path.resolve(':(top)scratch/cacbg/leak'),
    },
    encoding: 'utf8',
  });
  const out = `${res.stdout}${res.stderr}`;
  assert.notEqual(res.status, 0);
  assert.match(out, /does not ignore/, 'the literal name must be judged, not the magic resolution');
});

test('a localized git does not turn legitimate outside-repo overrides into refusals', () => {
  // Round 4: this machine runs bg_BG, where „not a git repository" arrives translated — the English
  // match then read a legitimate /tmp override as an unexplained failure and refused. gitEnv pins
  // LC_ALL=C, so the caller's locale must not matter.
  const res = spawnSync(process.execPath, [path.resolve('scripts/cacbg/extract.mjs')], {
    env: {
      ...process.env,
      LC_ALL: 'bg_BG.UTF-8',
      LANG: 'bg_BG.UTF-8',
      CACBG_RAW: fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-loc-raw-')),
      CACBG_STAGING: fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-loc-stg-')),
    },
    encoding: 'utf8',
  });
  const out = `${res.stdout}${res.stderr}`;
  assert.match(
    out,
    /REFUSE TO EXTRACT/,
    'the guard must PASS (the later corpus gate is what refuses)',
  );
  assert.doesNotMatch(out, /could not be verified/);
});

test('an inherited GIT_DIR cannot reach the DEFAULT-path scratch rail either', () => {
  // Round 4: assertOverrideDirSafe stripped GIT_* but assertScratchIgnored still inherited them — the
  // default-output rail could consult a decoy repository. Both rails now share gitEnv(). The decoy here
  // ignores NOTHING, so consulting it would refuse the probe; the REAL repo ignores scratch/ and the
  // run proceeds to the corpus gate.
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-decoy2-'));
  spawnSync('git', ['init', '-q', decoy], { encoding: 'utf8' });
  const res = spawnSync(process.execPath, [path.resolve('scripts/cacbg/extract.mjs')], {
    env: {
      ...process.env,
      GIT_DIR: path.join(decoy, '.git'),
      // The decoy's OWN empty worktree: .gitignore files are read from the work tree, so pointing the
      // work tree at the real checkout would answer "ignored" either way and hide the substitution.
      GIT_WORK_TREE: decoy,
    },
    encoding: 'utf8',
  });
  const out = `${res.stdout}${res.stderr}`;
  assert.match(out, /REFUSE TO EXTRACT/, 'the scratch rail must consult the real repository');
  assert.doesNotMatch(out, /not git-ignored/);
  fs.rmSync(decoy, { recursive: true, force: true });
});

test('an ignored SYMLINK into committable territory is judged by its destination', () => {
  // Round 4 (blocker, recovered from the truncated report): scratch/ is ignored, so a symlink
  // scratch/cacbg/leak → scripts/ passed the lexical check while extraction would write THROUGH it
  // into tracked files. The guard now canonicalizes before judging: the resolved location is scripts/,
  // which is tracked, and tracked refuses.
  const link = path.join('scratch', 'cacbg', 'leak-link');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.symlinkSync(path.resolve('scripts'), link);
    const res = spawnSync(process.execPath, [path.resolve('scripts/cacbg/extract.mjs')], {
      env: {
        ...process.env,
        CACBG_RAW: fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-sym-raw-')),
        CACBG_STAGING: path.resolve(link),
      },
      encoding: 'utf8',
    });
    const out = `${res.stdout}${res.stderr}`;
    assert.notEqual(res.status, 0, 'writing through the symlink reaches committable files');
    assert.match(out, /TRACKED|does not ignore/);
  } finally {
    fs.rmSync(link, { force: true });
  }
});

test('a symlink at the DEFAULT staging directory is caught, not only an override', () => {
  // Review round 5 (blocker 2): assertScratchIgnored probes only scratch/cacbg/.probe, so a symlink at
  // the sibling default `staging` — pointing into tracked territory — was invisible while extract I/O
  // followed it. The default paths now go through the canonicalizing guard unconditionally. Runs with
  // NO env overrides, so RAW/STAGING take their real default locations.
  const link = path.join('scratch', 'cacbg', 'staging');
  const raw = path.join('scratch', 'cacbg', 'raw');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const hadLink = fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false });
  if (hadLink) return; // never clobber a real local scratch tree
  fs.mkdirSync(raw, { recursive: true });
  try {
    fs.symlinkSync(path.resolve('scripts'), link); // default staging → tracked scripts/
    const res = spawnSync(process.execPath, [path.resolve('scripts/cacbg/extract.mjs')], {
      encoding: 'utf8', // no CACBG_* — exercises the DEFAULT path
    });
    const out = `${res.stdout}${res.stderr}`;
    assert.notEqual(res.status, 0, 'a symlinked default staging into tracked files must refuse');
    assert.match(out, /TRACKED|does not ignore/);
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(raw, { recursive: true, force: true });
  }
});
