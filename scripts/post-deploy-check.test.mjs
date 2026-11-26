import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awaitHealth,
  checkPages,
  codeDataVersion,
  compareGenerations,
  DEFAULT_PATHS,
  judgeHealth,
  parseArgs,
  REQUEST_TIMEOUT_MS,
  run,
  shortCommit,
  STALE_WINDOW_SECONDS,
} from './post-deploy-check.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const COMMIT = '0123456789ab';
const GEN = '2000-05-31 04:05:06';
const BASE = 'https://site.example';

function report(overrides = {}) {
  const { data, runs, ...rest } = overrides;
  return {
    status: 'ok',
    db: 'ok',
    checkedAt: '2000-06-01T00:00:00.000Z',
    code: { commit: COMMIT },
    data: {
      version: 5,
      builtAt: '2000-05-01T00:00:00Z',
      builtFromCommit: COMMIT,
      generation: GEN,
      asOf: '2000-05-30',
      ...data,
    },
    runs: {
      refresh: { publishedAt: GEN, unsettledWindows: 0, oldestUnsettledAgeSeconds: null },
      registry: { changesThrough: '2000-05-29' },
      declarations: { relatedPersonsPublishedAt: '2000-05-27T08:00:00Z' },
      ...runs,
    },
    ...rest,
  };
}

/**
 * A fake site. `health` is a list of reports served in turn (the last one repeats); `page(path, n)` gives
 * the headers of the n-th request for that path.
 */
function site({ health = [report()], page = () => ({}), healthHeaders = {} } = {}) {
  const requests = [];
  const signals = [];
  let healthCalls = 0;
  const pageCalls = new Map();
  const fetchImpl = async (url, init) => {
    const path = url.slice(BASE.length);
    requests.push(path);
    signals.push(init?.signal);
    if (path === '/health') {
      const body = health[Math.min(healthCalls++, health.length - 1)];
      if (body instanceof Error) throw body;
      if (typeof body === 'number') return new Response('<html>not found</html>', { status: body });
      return new Response(JSON.stringify(body), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...healthHeaders,
        },
      });
    }
    const n = (pageCalls.get(path) ?? 0) + 1;
    pageCalls.set(path, n);
    const { status = 200, ...headers } = {
      'X-Sigma-Version': COMMIT,
      'X-Sigma-Generation': GEN,
      'X-Edge-Cache': 'MISS',
      ...page(path, n),
    };
    for (const [k, v] of Object.entries(headers)) if (v === null) delete headers[k];
    return new Response('body', { status, headers });
  };
  return { fetchImpl, requests, signals };
}

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

const options = (extra = {}) => ({
  base: BASE,
  commit: SHA,
  strict: true,
  builtAt: null,
  dataVersion: 5,
  paths: ['/', '/contracts.data'],
  timeoutMs: 60_000,
  ...extra,
});

const quiet = { log: () => {} };

test('a site serving this commit and its generation passes', async () => {
  const { fetchImpl } = site();
  assert.deepEqual(await run(options(), { fetchImpl, ...clock(), ...quiet }), {
    failures: [],
    warnings: [],
  });
});

test('waits for the new version to reach the location before judging it', async () => {
  const old = report({ code: { commit: 'ffffffffffff' } });
  const { fetchImpl, requests } = site({ health: [404, old, report()] });
  const result = await run(options(), { fetchImpl, ...clock(), ...quiet });
  assert.deepEqual(result.failures, []);
  assert.equal(requests.filter((path) => path === '/health').length, 3);
});

test('fails when /health never reports the commit in time', async () => {
  const old = report({ code: { commit: 'ffffffffffff' } });
  const { fetchImpl } = site({ health: [old] });
  const { failures } = await run(options({ timeoutMs: 20_000 }), {
    fetchImpl,
    ...clock(),
    ...quiet,
  });
  assert.equal(failures.length, 1);
  assert.match(
    failures[0],
    /did not report commit 0123456789ab .* within 20s — last seen: HTTP 200, commit ffffffffffff/,
  );
});

test('fails when the old version has no /health at all', async () => {
  const { fetchImpl } = site({ health: [404] });
  const { failures } = await run(options({ timeoutMs: 0 }), { fetchImpl, ...clock(), ...quiet });
  assert.match(failures[0], /last seen: HTTP 404, not a health report/);
});

test('keeps waiting while D1 refuses /health, and fails in strict mode if it never answers', async () => {
  const degraded = report({ status: 'degraded', db: 'overloaded' });
  const recovers = site({ health: [degraded, degraded, report()] });
  assert.deepEqual(
    (await run(options(), { fetchImpl: recovers.fetchImpl, ...clock(), ...quiet })).failures,
    [],
  );

  const stuck = site({ health: [degraded] });
  const { failures } = await run(options({ timeoutMs: 10_000 }), {
    fetchImpl: stuck.fetchImpl,
    ...clock(),
    ...quiet,
  });
  assert.match(failures[0], /status degraded \(db overloaded\)/);
});

test("without --strict, a current build whose database never answers warns and still proves every page's build", async () => {
  const degraded = report({ status: 'degraded', db: 'overloaded' });
  const stuck = site({ health: [degraded] });
  const result = await run(options({ strict: false, timeoutMs: 10_000 }), {
    fetchImpl: stuck.fetchImpl,
    ...clock(),
    ...quiet,
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.warnings.length, 1);
  assert.match(
    result.warnings[0],
    /reports commit 0123456789ab but its database did not answer within 10s .*status degraded \(db overloaded\)\); the data version and generation are unproven/,
  );
  assert.deepEqual(
    stuck.requests.filter((path) => path !== '/health'),
    ['/', '/contracts.data'],
  );

  // The build is still checked: a page from another build fails, a degraded page does not matter.
  const wrongBuild = site({
    health: [degraded],
    page: (path) =>
      path === '/'
        ? { 'X-Sigma-Version': 'ffffffffffff', 'X-Edge-Cache': 'HIT' }
        : { 'X-Sigma-Generation': null, 'X-Sigma-Degraded': 'footer' },
  });
  const { failures } = await run(options({ strict: false, timeoutMs: 10_000 }), {
    fetchImpl: wrongBuild.fetchImpl,
    ...clock(),
    ...quiet,
  });
  assert.deepEqual(failures, [
    '/: rendered by build ffffffffffff, not 0123456789ab (X-Edge-Cache: HIT)',
  ]);
});

test('without --strict, a /health that never named this commit still fails', async () => {
  const old = report({ code: { commit: 'ffffffffffff' }, status: 'degraded', db: 'overloaded' });
  const { fetchImpl } = site({ health: [old] });
  const { failures, warnings } = await run(options({ strict: false, timeoutMs: 10_000 }), {
    fetchImpl,
    ...clock(),
    ...quiet,
  });
  assert.match(failures[0], /did not report commit 0123456789ab/);
  assert.deepEqual(warnings, []);
});

test('a degraded /health that could be cached is still a failure', async () => {
  const degraded = report({ status: 'degraded', db: 'overloaded' });
  const { fetchImpl } = site({
    health: [degraded],
    healthHeaders: { 'Cache-Control': 'public, s-maxage=60' },
  });
  const { failures } = await run(options({ strict: false, timeoutMs: 0 }), {
    fetchImpl,
    ...clock(),
    ...quiet,
  });
  assert.deepEqual(failures, ['/health may be cached (Cache-Control: public, s-maxage=60)']);
});

test('a network error while polling is a miss, not a crash', async () => {
  const { fetchImpl } = site({ health: [new Error('connection reset'), report()] });
  assert.deepEqual((await run(options(), { fetchImpl, ...clock(), ...quiet })).failures, []);
  const down = site({ health: [new Error('connection reset')] });
  const { failures } = await run(options({ timeoutMs: 0 }), {
    fetchImpl: down.fetchImpl,
    ...clock(),
    ...quiet,
  });
  assert.match(failures[0], /request failed: connection reset/);
});

test('fails when /health could be cached', async () => {
  const { fetchImpl } = site({ healthHeaders: { 'Cache-Control': 'public, s-maxage=60' } });
  const { failures } = await run(options(), { fetchImpl, ...clock(), ...quiet });
  assert.deepEqual(failures, ['/health may be cached (Cache-Control: public, s-maxage=60)']);
});

test('an older copy this build cached before a refresh is a warning, served by design', async () => {
  const { fetchImpl, requests } = site({
    page: (path) =>
      path === '/contracts.data'
        ? { 'X-Sigma-Generation': '2000-05-30 04:05:06', 'X-Edge-Cache': 'HIT' }
        : {},
  });
  const result = await run(options(), { fetchImpl, ...clock(), ...quiet });
  assert.deepEqual(result, {
    failures: [],
    warnings: [
      `/contracts.data: an edge copy of this build from before the refresh that published ${GEN} shows 2000-05-30 04:05:06; served by design until it expires`,
    ],
  });
  // Retrying does not change an edge copy.
  assert.equal(requests.filter((path) => path === '/contracts.data').length, 1);
});

test('a generation newer than /health, unreadable, or older on a fresh render fails', async () => {
  const cases = [
    [
      { 'X-Sigma-Generation': '2000-06-02 00:00:00', 'X-Edge-Cache': 'HIT' },
      `/: shows data generation 2000-06-02 00:00:00, /health says ${GEN} (X-Edge-Cache: HIT)`,
    ],
    [
      { 'X-Sigma-Generation': 'yesterday', 'X-Edge-Cache': 'HIT' },
      `/: shows data generation yesterday, which cannot be compared with /health's ${GEN}`,
    ],
    [
      { 'X-Sigma-Generation': '2000-05-30 04:05:06', 'X-Edge-Cache': 'MISS' },
      `/: shows data generation 2000-05-30 04:05:06, /health says ${GEN} (X-Edge-Cache: MISS)`,
    ],
    [
      { 'X-Sigma-Generation': null, 'X-Edge-Cache': 'MISS' },
      `/: names no data generation, /health says ${GEN} (X-Edge-Cache: MISS)`,
    ],
  ];
  for (const [headers, failure] of cases) {
    const { fetchImpl } = site({ page: (path) => (path === '/' ? headers : {}) });
    const { failures } = await run(options(), { fetchImpl, ...clock(), ...quiet });
    assert.deepEqual(failures, [failure]);
  }
});

test('an older copy from another build fails: the build is checked first', async () => {
  const { fetchImpl } = site({
    page: (path) =>
      path === '/'
        ? {
            'X-Sigma-Version': 'ffffffffffff',
            'X-Sigma-Generation': '2000-05-30 04:05:06',
            'X-Edge-Cache': 'HIT',
          }
        : {},
  });
  const { failures } = await run(options(), { fetchImpl, ...clock(), ...quiet });
  assert.deepEqual(failures, [
    '/: rendered by build ffffffffffff, not 0123456789ab (X-Edge-Cache: HIT)',
  ]);
});

test('fails when no page at all proves the generation, even if each one alone only warns', async () => {
  const everyPageOld = site({
    page: () => ({ 'X-Sigma-Generation': '2000-05-30 04:05:06', 'X-Edge-Cache': 'HIT' }),
  });
  const old = await run(options(), { fetchImpl: everyPageOld.fetchImpl, ...clock(), ...quiet });
  assert.deepEqual(old.failures, [
    `no page proved the data generation ${GEN} that /health reports`,
  ]);
  assert.equal(old.warnings.length, 2);

  const everyPageDegraded = site({
    page: () => ({ 'X-Sigma-Generation': null, 'X-Sigma-Degraded': 'footer' }),
  });
  const degraded = await run(options(), {
    fetchImpl: everyPageDegraded.fetchImpl,
    ...clock(),
    ...quiet,
  });
  assert.deepEqual(degraded.failures, [
    `no page proved the data generation ${GEN} that /health reports`,
  ]);
});

test('a page from the previous build fails after its retries', async () => {
  const { fetchImpl, requests } = site({
    page: (path) =>
      path === '/' ? { 'X-Sigma-Version': 'ffffffffffff', 'X-Edge-Cache': 'HIT' } : {},
  });
  const { failures } = await run(options(), { fetchImpl, ...clock(), ...quiet });
  assert.deepEqual(failures, [
    '/: rendered by build ffffffffffff, not 0123456789ab (X-Edge-Cache: HIT)',
  ]);
  assert.equal(requests.filter((path) => path === '/').length, 4);
});

test('a location still on the previous build is retried until it catches up', async () => {
  const { fetchImpl } = site({
    page: (path, n) => (path === '/' && n < 3 ? { 'X-Sigma-Version': 'ffffffffffff' } : {}),
  });
  assert.deepEqual((await run(options(), { fetchImpl, ...clock(), ...quiet })).failures, []);
});

test('a refresh that publishes during the check moves the expected generation on', async () => {
  const NEXT = '2000-06-01 10:00:00';
  const { fetchImpl } = site({
    health: [report(), report({ data: { generation: NEXT } })],
    page: (path) => (path === '/contracts.data' ? { 'X-Sigma-Generation': NEXT } : {}),
  });
  assert.deepEqual((await run(options(), { fetchImpl, ...clock(), ...quiet })).failures, []);
});

test('a page rendered without the footer row is retried, and warns if it stays so', async () => {
  const transient = site({
    page: (path, n) =>
      path === '/' && n === 1 ? { 'X-Sigma-Generation': null, 'X-Sigma-Degraded': 'footer' } : {},
  });
  assert.deepEqual(await run(options(), { fetchImpl: transient.fetchImpl, ...clock(), ...quiet }), {
    failures: [],
    warnings: [],
  });

  const persistent = site({
    page: (path) =>
      path === '/' ? { 'X-Sigma-Generation': null, 'X-Sigma-Degraded': 'footer' } : {},
  });
  const result = await run(options(), {
    fetchImpl: persistent.fetchImpl,
    ...clock(),
    ...quiet,
  });
  assert.deepEqual(result, {
    failures: [],
    warnings: [
      '/: rendered without its footer (D1 refused the read), so it does not prove the generation',
    ],
  });
  assert.equal(persistent.requests.filter((path) => path === '/').length, 4);
});

test('a page that does not answer 200 fails', async () => {
  const { fetchImpl } = site({ page: (path) => (path === '/' ? { status: 503 } : {}) });
  const { failures } = await run(options(), { fetchImpl, ...clock(), ...quiet });
  assert.deepEqual(failures, ['/: HTTP 503']);
});

test('every request gives up after its own timeout', async () => {
  const { fetchImpl, signals } = site();
  await run(options(), { fetchImpl, ...clock(), ...quiet });
  assert.ok(signals.length > 0);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal));
  assert.equal(REQUEST_TIMEOUT_MS, 15_000);

  const hung = async (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
  const { failures } = await run(options({ timeoutMs: 0 }), {
    fetchImpl: hung,
    ...clock(),
    ...quiet,
    requestTimeoutMs: 5,
  });
  assert.match(failures[0], /last seen: request failed: .*timeout/i);
});

test('a page request that throws is reported, not a crash', async () => {
  const { fetchImpl: base } = site();
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/contracts.data')) throw new Error('timeout');
    return base(url, init);
  };
  const { failures } = await run(options(), { fetchImpl, ...clock(), ...quiet });
  assert.deepEqual(failures, ['/contracts.data: request failed: timeout']);
});

test('another data version fails in strict mode and warns otherwise', async () => {
  const { fetchImpl } = site({ health: [report({ data: { version: 4 } })] });
  const strict = await run(options(), { fetchImpl, ...clock(), ...quiet });
  assert.deepEqual(strict.failures, [
    'the served slot holds data version 4, this code computes version 5',
  ]);
  const lenient = await run(options({ strict: false }), { fetchImpl, ...clock(), ...quiet });
  assert.deepEqual(lenient, {
    failures: [],
    warnings: ['the served slot holds data version 4, this code computes version 5'],
  });
});

test('a slot without a data version is named as such', () => {
  const { failures } = judgeHealth(report({ data: { version: null } }), {
    expectedVersion: 5,
    builtAt: null,
    strict: true,
  });
  assert.deepEqual(failures, [
    'the served slot holds data version none, this code computes version 5',
  ]);
});

test('--built-at proves the switch reached the new slot', async () => {
  const { fetchImpl } = site();
  const switched = await run(options({ builtAt: '2000-05-01T00:00:00Z' }), {
    fetchImpl,
    ...clock(),
    ...quiet,
  });
  assert.deepEqual(switched.failures, []);
  const notYet = await run(options({ builtAt: '2000-05-20T00:00:00Z' }), {
    fetchImpl,
    ...clock(),
    ...quiet,
  });
  assert.deepEqual(notYet.failures, [
    'the served slot was built at 2000-05-01T00:00:00Z, expected 2000-05-20T00:00:00Z — the switch has not taken effect',
  ]);
});

test('a slot with no published generation fails without checking pages', async () => {
  const { fetchImpl, requests } = site({ health: [report({ data: { generation: null } })] });
  const { failures } = await run(options(), { fetchImpl, ...clock(), ...quiet });
  assert.deepEqual(failures, ['the served slot has no published data generation']);
  assert.deepEqual(requests, ['/health']);
});

test('unsettled refresh windows warn only once they outlive a refresh cycle', () => {
  const windows = (age) =>
    report({
      runs: {
        refresh: { publishedAt: GEN, unsettledWindows: 2, oldestUnsettledAgeSeconds: age },
      },
    });
  const judge = (body) => judgeHealth(body, { expectedVersion: 5, builtAt: null, strict: true });
  const old = judge(windows(STALE_WINDOW_SECONDS + 3600));
  assert.deepEqual(old.failures, []);
  assert.deepEqual(old.warnings, [
    '2 refresh window(s) are not settled, the oldest for 7 h: a run did not pass its integrity gate or stopped',
  ]);
  assert.deepEqual(judge(windows(STALE_WINDOW_SECONDS)).warnings, []);
  assert.deepEqual(judge(report({ runs: { refresh: undefined } })).warnings, []);
});

test('a last refresh that did not verify warns, with when the numbers were last verified', () => {
  const verdict = (fields) =>
    report({
      runs: {
        refresh: {
          publishedAt: GEN,
          unsettledWindows: 0,
          oldestUnsettledAgeSeconds: null,
          ...fields,
        },
      },
    });
  const judge = (body) => judgeHealth(body, { expectedVersion: 5, builtAt: null, strict: true });
  const at = '2000-05-31T06:35:00.000Z';
  assert.deepEqual(
    judge(verdict({ verdict: 'violation', verdictAt: at, verifiedAt: '2000-05-31T00:34:00.000Z' })),
    {
      failures: [],
      warnings: [
        `the last refresh's integrity verdict is violation (${at}); the numbers were last verified 2000-05-31T00:34:00.000Z`,
      ],
    },
  );
  assert.deepEqual(
    judge(verdict({ verdict: 'unverified', verdictAt: at, verifiedAt: null })).warnings,
    [
      `the last refresh's integrity verdict is unverified (${at}); the numbers were last verified never on this slot`,
    ],
  );
  assert.deepEqual(judge(verdict({ verdict: 'ok', verdictAt: at, verifiedAt: at })).warnings, []);
  // A slot no refresh has reached the gate on, or a report from before the field existed.
  assert.deepEqual(judge(verdict({ verdict: null })).warnings, []);
  assert.deepEqual(judge(verdict({})).warnings, []);
});

test('generations compare as times, and an unreadable one does not compare', () => {
  assert.equal(compareGenerations('2000-05-30 04:05:06', GEN), -1);
  assert.equal(compareGenerations(GEN, '2000-05-31T04:05:06Z'), 0);
  assert.equal(compareGenerations('2000-06-01 00:00:00.5', GEN), 1);
  assert.equal(compareGenerations('yesterday', GEN), null);
  assert.equal(compareGenerations(GEN, null), null);
  assert.equal(compareGenerations('2000-13-45 00:00:00', GEN), null);
});

test('awaitHealth asks once more right at the deadline, never past it', async () => {
  const { now, sleep } = clock();
  const old = report({ code: { commit: 'ffffffffffff' } });
  const { fetchImpl, requests } = site({ health: [old] });
  const { ready } = await awaitHealth(fetchImpl, BASE, COMMIT, {
    timeoutMs: 15_000,
    intervalMs: 5_000,
    sleep,
    now,
  });
  assert.equal(ready, false);
  assert.equal(requests.length, 4);
  assert.equal(now(), 15_000);
});

test('checkPages releases every body and reports what passed', async () => {
  const { fetchImpl } = site();
  const result = await checkPages(fetchImpl, BASE, COMMIT, GEN, ['/', '/companies.data'], {
    intervalMs: 1,
    sleep: async () => {},
  });
  assert.deepEqual(result, {
    failures: [],
    warnings: [],
    passed: ['/ (MISS)', '/companies.data (MISS)'],
    generation: GEN,
  });
});

test('parseArgs takes the site, the commit and the options', () => {
  assert.deepEqual(
    parseArgs([
      'https://site.example/',
      '--commit',
      SHA,
      '--strict',
      '--built-at',
      '2000-05-01T00:00:00Z',
      '--data-version',
      '4',
      '--path',
      '/map',
      '--timeout',
      '30',
    ]),
    {
      base: 'https://site.example',
      commit: SHA,
      strict: true,
      builtAt: '2000-05-01T00:00:00Z',
      dataVersion: 4,
      paths: ['/map'],
      timeoutMs: 30_000,
    },
  );
  const defaults = parseArgs([BASE, '--commit', SHA]);
  assert.equal(defaults.strict, false);
  assert.equal(defaults.dataVersion, null);
  assert.equal(defaults.timeoutMs, 180_000);
  assert.deepEqual(defaults.paths, DEFAULT_PATHS);
});

test('parseArgs refuses what it cannot check', () => {
  assert.throws(() => parseArgs(['--commit', SHA]), /site URL is required/);
  assert.throws(() => parseArgs([BASE]), /--commit <sha> is required/);
  assert.throws(() => parseArgs([BASE, '--commit', '0123456']), /at least the 12 characters/);
  assert.throws(
    () => parseArgs([BASE, '--commit', SHA, '--data-version', 'x']),
    /must be an integer/,
  );
  assert.throws(() => parseArgs([BASE, '--commit', SHA, '--timeout', 'soon']), /seconds/);
  assert.throws(() => parseArgs([BASE, '--commit', SHA, '--built-at']), /--built-at needs a value/);
  assert.throws(() => parseArgs([BASE, '--commit', SHA, '--bogus']), /unknown option --bogus/);
  assert.throws(
    () => parseArgs([BASE, 'https://other.example', '--commit', SHA]),
    /unexpected argument/,
  );
});

test('the commit is compared as the site writes it', () => {
  assert.equal(shortCommit(SHA.toUpperCase()), COMMIT);
});

test('the expected data version defaults to the one this code computes', async () => {
  assert.ok(Number.isInteger(codeDataVersion()));
  const { fetchImpl } = site({ health: [report({ data: { version: codeDataVersion() } })] });
  const result = await run(options({ dataVersion: null }), { fetchImpl, ...clock(), ...quiet });
  assert.deepEqual(result.failures, []);
});

test('the default paths cover pages and their data twins', () => {
  assert.ok(DEFAULT_PATHS.includes('/'));
  assert.ok(DEFAULT_PATHS.some((path) => path.endsWith('.data')));
  assert.ok(DEFAULT_PATHS.every((path) => path.startsWith('/')));
});
