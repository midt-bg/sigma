import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryD1 } from './d1-retry.mjs';

const RACE = 'Command failed: wrangler d1 execute … ✘ [ERROR] Not currently importing anything.';

test('a repeatable D1 call survives two failures and returns the answer of the third attempt', () => {
  const waits = [];
  const lines = [];
  let calls = 0;
  const answer = retryD1(
    () => {
      calls++;
      if (calls < 3) throw new Error(RACE);
      return 'done';
    },
    {
      label: '0010_publishing_gate_constraints',
      sleep: (ms) => waits.push(ms),
      log: (l) => lines.push(l),
    },
  );
  assert.equal(answer, 'done');
  assert.equal(calls, 3);
  // Fifteen seconds after the first failure, thirty after the second.
  assert.deepEqual(waits, [15_000, 30_000]);
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), {
    event: 'd1_call_retried',
    label: '0010_publishing_gate_constraints',
    attempt: 1,
    of: 3,
    waitMs: 15_000,
    error: RACE,
  });
});

test('the last failure is the error the run reports, after exactly the allowed attempts', () => {
  let calls = 0;
  const last = new Error('D1_ERROR: D1 DB is overloaded');
  assert.throws(
    () =>
      retryD1(
        () => {
          calls++;
          throw calls < 3 ? new Error(RACE) : last;
        },
        { label: 'export', sleep: () => {}, log: () => {} },
      ),
    (error) => error === last,
  );
  assert.equal(calls, 3);
});

test('a call that answers at once is called once and waits for nothing', () => {
  let calls = 0;
  const waits = [];
  assert.equal(
    retryD1(
      () => {
        calls++;
        return 42;
      },
      { label: 'info', sleep: (ms) => waits.push(ms), log: () => assert.fail('nothing to log') },
    ),
    42,
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('the attempt budget and the wait are the caller’s to set, and a thrown non-Error is reported too', () => {
  const waits = [];
  const lines = [];
  assert.throws(
    () =>
      retryD1(
        () => {
          throw 'plain string';
        },
        {
          label: 'x',
          attempts: 2,
          waitMs: () => 5,
          sleep: (ms) => waits.push(ms),
          log: (l) => lines.push(l),
        },
      ),
    (error) => error === 'plain string',
  );
  assert.deepEqual(waits, [5]);
  assert.equal(JSON.parse(lines[0]).error, 'plain string');
});

test('without injected helpers it sleeps for real and logs to stderr', (t) => {
  const lines = [];
  t.mock.method(console, 'error', (line) => lines.push(line));
  let calls = 0;
  const started = Date.now();
  const answer = retryD1(
    () => {
      calls++;
      if (calls === 1) throw new Error(RACE);
      return 'ok';
    },
    { label: 'reindex-officials-017', waitMs: () => 20 },
  );
  assert.equal(answer, 'ok');
  assert.ok(Date.now() - started >= 20, 'the pause is a real wait');
  assert.equal(JSON.parse(lines[0]).label, 'reindex-officials-017');
});
