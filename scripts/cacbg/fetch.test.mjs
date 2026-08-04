// node:test — pure crawl-option + circuit-breaker helpers of the CACBG crawler. No I/O.
// Guards two silent-failure footguns ydimitrof flagged: (1) an unvalidated --concurrency/--limit that
// degrades to a no-op crawl, and (2) a circuit breaker blind to a sustained non-200 (403/429/5xx) wall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCrawlOptions, nextBreaker, BREAKER_TRIP, assessCompleteness } from './fetch.mjs';

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

// --- completeness gate (Todor #2): announced↔obtained reconciliation, 404 is a legit source gap ---
test('parseCrawlOptions: --allow-incomplete defaults false, present → true', () => {
  assert.equal(parseCrawlOptions([]).allowIncomplete, false);
  assert.equal(parseCrawlOptions(['--allow-incomplete']).allowIncomplete, true);
});
test('assessCompleteness: fetched + cached + 404 only → complete (404 is a source gap, not a shortfall)', () => {
  const r = assessCompleteness(
    { 2024: { announced: 10, fetched: 6, cached: 3, missing: 1, errors: 0 } },
    [],
  );
  assert.equal(r.obtained, 9);
  assert.equal(r.sourceGaps, 1);
  assert.equal(r.unfetched, 0);
  assert.equal(r.incomplete, false);
});
test('assessCompleteness: a non-404 unfetched declaration marks the corpus INCOMPLETE', () => {
  const r = assessCompleteness(
    { 2024: { announced: 10, fetched: 6, cached: 1, missing: 1, errors: 2 } },
    [],
  );
  assert.equal(r.unfetched, 2);
  assert.equal(r.incomplete, true);
});
test('assessCompleteness: a skipped set (list.xml unavailable) marks the corpus INCOMPLETE', () => {
  const r = assessCompleteness({}, [{ folder: '2025', status: 503 }]);
  assert.equal(r.skippedSets, 1);
  assert.equal(r.incomplete, true);
});
test('assessCompleteness: an empty crawl of fully-obtained sets is complete', () => {
  const r = assessCompleteness(
    {
      a: { announced: 2, fetched: 2, cached: 0, missing: 0, errors: 0 },
      b: { announced: 0, fetched: 0, cached: 0, missing: 0, errors: 0 },
    },
    [],
  );
  assert.equal(r.reachedSets, 2);
  assert.equal(r.announcedDeclarations, 2);
  assert.equal(r.incomplete, false);
});

// --limit truncates the WORK, never the announcement. Before this, `announced` was read after the slice,
// so a deliberately partial crawl reported announced == obtained and the gate certified a corpus it had
// never tried to fetch. Rows that were never attempted produce no errors, so `incomplete` has to notice
// the arithmetic hole itself: announced > obtained + sourceGaps + unfetched.
test('assessCompleteness: rows announced but never attempted (--limit) mark the corpus INCOMPLETE', () => {
  const r = assessCompleteness(
    { 2024: { announced: 5000, fetched: 10, cached: 0, missing: 0, errors: 0 } },
    [],
  );
  assert.equal(r.notAttempted, 4990);
  assert.equal(r.unfetched, 0, 'no fetch was even tried, so nothing can have errored');
  assert.equal(r.incomplete, true);
});
test('assessCompleteness: notAttempted is 0 when every announced row landed in a bucket', () => {
  const r = assessCompleteness(
    { 2024: { announced: 10, fetched: 6, cached: 3, missing: 1, errors: 0 } },
    [],
  );
  assert.equal(r.notAttempted, 0);
  assert.equal(r.incomplete, false);
});
