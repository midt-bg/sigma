import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { supervise } from '../containers/declarations/server.mjs';

function childStatus() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const sink = { write() {} };
  const status = supervise(child, 'logical-run', 2, [sink, sink]);
  const event = (value) => child.stdout.write(JSON.stringify(value) + '\n');
  return { child, status, event };
}

test('supervisor preserves progress and a useful error or intentional yield', () => {
  const { child, status, event } = childStatus();
  event({ event: 'declarations_progress', stage: 'extract', completed: 45, total: 100 });
  child.stderr.write('Error: checksum mismatch\n');
  child.emit('close', 1, null);
  assert.equal(status.stage, 'extract');
  assert.equal(status.completed, 45);
  assert.equal(status.reason, 'Error: checksum mismatch');
  assert.equal(status.state, 'failed');
  const yielded = childStatus();
  yielded.child.emit('close', 75, null);
  assert.equal(yielded.status.state, 'yielded');
});

test('exit zero requires an audited publication receipt for this logical run', () => {
  for (const runId of ['another-run', 'logical-run']) {
    const { child, status, event } = childStatus();
    event({ event: 'declarations_job_complete', runId, audit: true, published: true });
    child.emit('close', 0, null);
    assert.equal(status.state, runId === 'logical-run' ? 'complete' : 'failed');
  }
  const missing = childStatus();
  missing.child.emit('close', 0, null);
  assert.equal(missing.status.state, 'failed');
});

test('nested process signal survives the wrapper exit so the coordinator can resume', () => {
  const { child, status, event } = childStatus();
  event({
    event: 'declarations_error',
    stage: 'load',
    script: 'load.mjs',
    exitCode: null,
    signal: 'SIGKILL',
  });
  child.emit('close', 1, null);
  assert.equal(status.state, 'failed');
  assert.equal(status.signal, 'SIGKILL');
  assert.match(status.reason, /load.mjs.*SIGKILL/);
});
