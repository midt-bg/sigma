import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { retryD1, sendWithReceipt, withReceipt } from './d1-retry.mjs';

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

// A target that behaves as D1 does for one file: all of it or none of it. Its table has a primary key, so a
// chunk sent twice fails on the second copy, as the staged tables do.
function target() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY);');
  return {
    apply: (body) => {
      db.exec('BEGIN');
      try {
        db.exec(body);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    readReceipt: (label) => {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='rp_receipt'").get()) return null;
      return db.prepare('SELECT token FROM rp_receipt WHERE label=?').get(label)?.token ?? null;
    },
    rows: () => db.prepare('SELECT COUNT(*) n FROM rows').get().n,
  };
}
const quiet = { waitMs: () => 0, sleep: () => {} };

test('the receipt is the last statement of the file it travels with', () => {
  const body = withReceipt('INSERT INTO rows VALUES(1);', "rows.0 o'clock", 't-1');
  assert.ok(body.startsWith('INSERT INTO rows VALUES(1);\n'));
  assert.ok(body.endsWith("INSERT OR REPLACE INTO rp_receipt VALUES('rows.0 o''clock', 't-1');\n"));
});

test('a file that landed but was reported as failed is not sent again', () => {
  const db = target();
  const lines = [];
  let sends = 0;
  sendWithReceipt(
    'INSERT INTO rows VALUES(1);',
    (body) => {
      sends++;
      db.apply(body);
      throw new Error(RACE);
    },
    { label: 'publish', readReceipt: db.readReceipt, log: (l) => lines.push(l), ...quiet },
  );
  assert.equal(sends, 1);
  assert.equal(db.rows(), 1);
  assert.equal(JSON.parse(lines[0]).event, 'd1_file_landed_despite_error');
});

test('a file that did not land is sent again, and the landing ends it', () => {
  const db = target();
  const lines = [];
  let sends = 0;
  sendWithReceipt(
    'INSERT INTO rows VALUES(1);',
    (body) => {
      if (++sends === 1) throw new Error('D1_ERROR: 7009');
      db.apply(body);
    },
    { label: 'rows.0', readReceipt: db.readReceipt, log: (l) => lines.push(l), ...quiet },
  );
  assert.equal(sends, 2);
  assert.equal(db.rows(), 1);
  assert.deepEqual(
    lines.map((l) => [JSON.parse(l).event, JSON.parse(l).receipt]),
    [['d1_call_retried', 'absent']],
  );
});

test('an earlier receipt under the same label is not this sending', () => {
  const db = target();
  db.apply(withReceipt('INSERT INTO rows VALUES(1);', 'registry-batch', 'earlier'));
  let sends = 0;
  sendWithReceipt(
    'INSERT INTO rows VALUES(2);',
    (body) => {
      if (++sends === 1) throw new Error('D1_ERROR: 7009');
      db.apply(body);
    },
    { label: 'registry-batch', readReceipt: db.readReceipt, log: () => {}, ...quiet },
  );
  assert.equal(sends, 2);
  assert.equal(db.rows(), 2);
});

test('a file that never lands fails with its last error after the allowed attempts', () => {
  const db = target();
  const waits = [];
  let sends = 0;
  assert.throws(
    () =>
      sendWithReceipt(
        'INSERT INTO rows VALUES(1);',
        () => {
          throw new Error(`D1_ERROR: 7009 #${++sends}`);
        },
        {
          label: 'rows.0',
          readReceipt: db.readReceipt,
          log: () => {},
          waitMs: (n) => 30_000 * n,
          sleep: (ms) => waits.push(ms),
        },
      ),
    /7009 #3/,
  );
  assert.equal(sends, 3);
  assert.equal(db.rows(), 0);
  assert.deepEqual(waits, [30_000, 60_000, 90_000]);
});

test('a receipt that cannot be read stops the run instead of sending again', () => {
  let sends = 0;
  let reads = 0;
  assert.throws(
    () =>
      sendWithReceipt(
        'INSERT INTO rows VALUES(1);',
        () => {
          sends++;
          throw new Error(RACE);
        },
        {
          label: 'publish',
          readReceipt: () => {
            reads++;
            throw new Error('D1 is unreachable');
          },
          log: () => {},
          ...quiet,
        },
      ),
    /cannot tell whether publish was applied: .*D1 is unreachable.*Not currently importing/,
  );
  assert.equal(sends, 1);
  assert.equal(reads, 3);
});
