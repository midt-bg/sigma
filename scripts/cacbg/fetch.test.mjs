// node:test — pure crawl-option + circuit-breaker helpers of the CACBG crawler. No I/O.
// Every case here guards an option or counter that fails SILENTLY when it fails, which is why they are
// worth unit tests at all: (1) an unvalidated --concurrency/--limit that degrades to a no-op crawl, and
// (2) a circuit breaker blind to a sustained non-200 (403/429/5xx) wall — both flagged by ydimitrof;
// (3) --deadline-minutes, where a bad value means „no deadline" rather than an error; (4) a flag given
// with no value at all, which used to read as „not given"; and (5) the politeness ceiling on concurrency,
// which had a floor but no roof. The end-to-end behaviour of the deadline lives in fetch-gate.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCrawlOptions,
  nextBreaker,
  BREAKER_TRIP,
  MAX_CONCURRENCY,
  assessCompleteness,
} from './fetch.mjs';

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

// --- --deadline-minutes: absent means no cap (a hand-run crawl), and garbage must fail like the rest ---
test('parseCrawlOptions: no --deadline-minutes → Infinity (an uncapped crawl)', () => {
  assert.equal(parseCrawlOptions([]).deadlineMinutes, Infinity);
});
test('parseCrawlOptions: --deadline-minutes parses', () => {
  assert.equal(parseCrawlOptions(['--deadline-minutes', '240']).deadlineMinutes, 240);
});
test('parseCrawlOptions: non-numeric --deadline-minutes throws (not NaN → uncapped crawl)', () => {
  // NaN is not finite, so an unvalidated value would silently mean „no deadline" — the exact failure the
  // deadline exists to prevent, restored by a typo.
  assert.throws(
    () => parseCrawlOptions(['--deadline-minutes', 'abc']),
    /deadline-minutes must be a positive integer/,
  );
});
test('parseCrawlOptions: zero/negative/fractional --deadline-minutes throws', () => {
  assert.throws(() => parseCrawlOptions(['--deadline-minutes', '0']), /deadline-minutes/);
  assert.throws(() => parseCrawlOptions(['--deadline-minutes', '-5']), /deadline-minutes/);
  assert.throws(() => parseCrawlOptions(['--deadline-minutes', '2.5']), /deadline-minutes/);
});

// A flag present but valueless used to fall through to the DEFAULT, which for the deadline means „no
// deadline at all" — the feature switched off by a typo, with nothing said. Same shape for the older flags.
test('parseCrawlOptions: a valueless flag throws instead of silently defaulting', () => {
  assert.throws(
    () => parseCrawlOptions(['--deadline-minutes']),
    /--deadline-minutes was given without/,
  );
  assert.throws(() => parseCrawlOptions(['--limit']), /--limit was given without/);
  assert.throws(() => parseCrawlOptions(['--concurrency']), /--concurrency was given without/);
  assert.throws(() => parseCrawlOptions(['--folders']), /--folders was given without/);
});
test('parseCrawlOptions: a flag swallowed by the NEXT flag throws too', () => {
  // `--deadline-minutes --allow-incomplete` reads as „deadline = --allow-incomplete"; Number() of that is
  // NaN, but only because posInt rejects it — the value must be refused before it is ever interpreted.
  assert.throws(
    () => parseCrawlOptions(['--deadline-minutes', '--allow-incomplete']),
    /--deadline-minutes was given without/,
  );
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

// --concurrency had a floor but no roof: `--concurrency 500` was an accepted way to open five hundred
// simultaneous connections to a state register, from the very script whose backoff and circuit breaker
// exist to prevent that. The ceiling is what the workflow actually runs, so tuning DOWN stays free and
// tuning up is a deliberate edit.
test('parseCrawlOptions: --concurrency above the politeness ceiling throws', () => {
  assert.throws(
    () => parseCrawlOptions(['--concurrency', String(MAX_CONCURRENCY + 1)]),
    /at most 8 — the register is a state server/,
  );
  assert.throws(() => parseCrawlOptions(['--concurrency', '500']), /at most 8/);
});
test('parseCrawlOptions: the ceiling itself is allowed — it is what the workflow runs', () => {
  assert.equal(parseCrawlOptions(['--concurrency', String(MAX_CONCURRENCY)]).concurrency, 8);
  assert.equal(MAX_CONCURRENCY, 8, 'the workflow passes --concurrency 8; keep them in lockstep');
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
