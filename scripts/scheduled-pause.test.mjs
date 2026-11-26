import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describePause, MAX_HOURS, PAUSE_KEY, pauseBody, runPause } from './scheduled-pause.mjs';

const NOW = new Date('2026-11-26T10:00:00.000Z');
const OBJECT = `sigma-declarations-test/${PAUSE_KEY}`;

/** A wrangler double that records its calls and answers from a script of results. */
function fakeWrangler(answer = () => '') {
  const calls = [];
  const wrangler = (args, input) => {
    calls.push({ args, input });
    return answer(args);
  };
  return { calls, wrangler };
}

test('the key is the one the ETL reads', () => {
  assert.match(
    readFileSync('apps/etl/src/pause.ts', 'utf8'),
    new RegExp(`SCHEDULED_PAUSE_KEY = '${PAUSE_KEY}'`),
  );
});

test('set writes a hold that ends by itself, with its reason', () => {
  const { calls, wrangler } = fakeWrangler();
  const lines = runPause(
    ['set', 'sigma-declarations-test', '--hours', '3', '--reason', ' slot switch '],
    { wrangler, now: NOW },
  );
  assert.deepEqual(calls[0].args, [
    'r2',
    'object',
    'put',
    OBJECT,
    '--remote',
    '--pipe',
    '--content-type',
    'application/json',
  ]);
  assert.deepEqual(JSON.parse(calls[0].input), {
    until: '2026-11-26T13:00:00.000Z',
    reason: 'slot switch',
    setAt: NOW.toISOString(),
  });
  assert.deepEqual(lines, [
    'sigma-declarations-test: HELD until 2026-11-26T13:00:00.000Z (3 h 0 min left): slot switch',
  ]);
});

test('set refuses a hold without an expiry, past a week, or without a reason — and writes nothing', () => {
  for (const flags of [
    ['--reason', 'no hours'],
    ['--hours', '0', '--reason', 'zero'],
    ['--hours', '1.5', '--reason', 'fraction'],
    ['--hours', String(MAX_HOURS + 1), '--reason', 'too long'],
    ['--hours', 'soon', '--reason', 'not a number'],
  ]) {
    const { calls, wrangler } = fakeWrangler();
    assert.throws(
      () => runPause(['set', 'b', ...flags], { wrangler, now: NOW }),
      /--hours must be a whole number from 1 to 168/,
    );
    assert.equal(calls.length, 0);
  }
  for (const flags of [
    ['--hours', '2'],
    ['--hours', '2', '--reason', '  '],
  ]) {
    assert.throws(
      () => runPause(['set', 'b', ...flags], { wrangler: fakeWrangler().wrangler, now: NOW }),
      /--reason is required/,
    );
  }
  assert.equal(
    pauseBody({ hours: MAX_HOURS, reason: 'a week', now: NOW }).until,
    '2026-12-03T10:00:00.000Z',
  );
});

test('clear deletes the object', () => {
  const { calls, wrangler } = fakeWrangler();
  assert.deepEqual(runPause(['clear', 'sigma-declarations-test'], { wrangler, now: NOW }), [
    'sigma-declarations-test: hold cleared, the next tick starts as usual',
  ]);
  assert.deepEqual(calls[0].args, ['r2', 'object', 'delete', OBJECT, '--remote']);
});

test('show reads the object as the ETL does', () => {
  const stored = (body) => fakeWrangler(() => body).wrangler;
  const show = (wrangler) => runPause(['show', 'b'], { wrangler, now: NOW })[0];
  assert.equal(
    show(stored('{"until":"2026-11-26T11:30:00.000Z","reason":"incident"}')),
    'b: HELD until 2026-11-26T11:30:00.000Z (1 h 30 min left): incident',
  );
  assert.equal(
    show(stored('{"until":"2026-11-26T09:00:00.000Z","reason":"incident"}')),
    'b: expired at 2026-11-26T09:00:00.000Z, no longer held (incident); clear removes the object',
  );
  assert.match(show(stored('{"reason":"no expiry"}')), /^b: not a valid hold, ignored by the ETL/);
  assert.match(show(stored('{"until":"2026-11-27T00:00:00Z"}')), /not a valid hold/);
  assert.match(show(stored('garbage')), /not a valid hold/);
  assert.match(show(stored('{"until":2030,"reason":"a number"}')), /not a valid hold/);
  const absent = fakeWrangler(() => {
    throw Object.assign(new Error('Command failed'), {
      stderr: 'The specified key does not exist.',
    });
  });
  assert.equal(show(absent.wrangler), 'b: no hold: the scheduled runs start as usual');
  assert.deepEqual(absent.calls[0].args, [
    'r2',
    'object',
    'get',
    `b/${PAUSE_KEY}`,
    '--remote',
    '--pipe',
  ]);
});

test('show does not report „no hold" when it could not read the bucket', () => {
  const denied = fakeWrangler(() => {
    throw Object.assign(new Error('Command failed'), {
      stderr: 'Authentication error [code: 10000]',
    });
  });
  assert.throws(
    () => runPause(['show', 'b'], { wrangler: denied.wrangler, now: NOW }),
    /Command failed/,
  );
});

test('an unknown action or a missing bucket is a usage error', () => {
  for (const argv of [[], ['pause', 'b'], ['show'], ['set', '--hours', '2']])
    assert.throws(() => runPause(argv, { wrangler: fakeWrangler().wrangler }), /usage:/);
});

test('describePause reads a hold as expired at its very expiry, as the ETL does', () => {
  assert.match(
    describePause('{"until":"2026-11-26T10:00:00.000Z","reason":"r"}', NOW),
    /^expired at/,
  );
});

test('describePause names the minutes left', () => {
  assert.equal(
    describePause('{"until":"2026-11-26T10:00:30.000Z","reason":"r"}', NOW),
    'HELD until 2026-11-26T10:00:30.000Z (0 h 1 min left): r',
  );
});
