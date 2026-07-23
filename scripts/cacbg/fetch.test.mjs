// node:test — pure crawl-option + circuit-breaker helpers of the CACBG crawler. No I/O.
// Guards two silent-failure footguns ydimitrof flagged: (1) an unvalidated --concurrency/--limit that
// degrades to a no-op crawl, and (2) a circuit breaker blind to a sustained non-200 (403/429/5xx) wall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCrawlOptions, nextBreaker, BREAKER_TRIP } from './fetch.mjs';

test('parseCrawlOptions: defaults — no limit, 6 workers', () => {
  const o = parseCrawlOptions([]);
  assert.equal(o.concurrency, 6);
  assert.equal(o.limit, Infinity);
  assert.equal(o.folders, '');
});

test('parseCrawlOptions: valid overrides parse', () => {
  const o = parseCrawlOptions([
    '--limit',
    '300',
    '--concurrency',
    '3',
    '--folders',
    '2021_nc,2025y',
  ]);
  assert.equal(o.limit, 300);
  assert.equal(o.concurrency, 3);
  assert.equal(o.folders, '2021_nc,2025y');
});

// --- the footgun: a bad concurrency must FAIL LOUD, not spin up zero workers and exit 0 ---
test('parseCrawlOptions: non-numeric --concurrency throws (not NaN → 0 workers → silent no-op)', () => {
  assert.throws(
    () => parseCrawlOptions(['--concurrency', 'abc']),
    /concurrency must be a positive integer/,
  );
});
test('parseCrawlOptions: zero/negative --concurrency throws', () => {
  assert.throws(() => parseCrawlOptions(['--concurrency', '0']), /concurrency/);
  assert.throws(() => parseCrawlOptions(['--concurrency', '-2']), /concurrency/);
});
test('parseCrawlOptions: fractional --concurrency throws', () => {
  assert.throws(() => parseCrawlOptions(['--concurrency', '2.5']), /concurrency/);
});

// --- the other footgun: a bad --limit silently fetched EVERYTHING (NaN → not finite → no slice) ---
test('parseCrawlOptions: non-numeric --limit throws (not NaN → silent fetch-all)', () => {
  assert.throws(() => parseCrawlOptions(['--limit', 'abc']), /limit must be a positive integer/);
});
test('parseCrawlOptions: zero/negative --limit throws', () => {
  assert.throws(() => parseCrawlOptions(['--limit', '0']), /limit/);
  assert.throws(() => parseCrawlOptions(['--limit', '-5']), /limit/);
});

// --- circuit breaker: a non-200 wall must accumulate exactly like a network throw ---
test('nextBreaker: a failure (throw OR non-200) increments', () => {
  assert.equal(nextBreaker(0, 'fail'), 1);
  assert.equal(nextBreaker(24, 'fail'), 25);
});
test('nextBreaker: success and 404-missing reset to zero', () => {
  assert.equal(nextBreaker(10, 'ok'), 0);
  assert.equal(nextBreaker(10, 'missing'), 0);
});
test('nextBreaker: a sustained non-200 wall crosses the trip threshold', () => {
  // Simulate the previously-blind branch: 26 consecutive non-200s must exceed BREAKER_TRIP (was: never).
  let c = 0;
  for (let i = 0; i < BREAKER_TRIP + 1; i++) c = nextBreaker(c, 'fail');
  assert.ok(c > BREAKER_TRIP, `expected > ${BREAKER_TRIP}, got ${c}`);
});
