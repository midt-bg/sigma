import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { resources, supervise } from '../containers/declarations/server.mjs';

function childStatus() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const lines = [];
  const sink = { write: (line) => lines.push(line) };
  const status = supervise(child, 'logical-run', 2, [sink, sink]);
  const event = (value) => child.stdout.write(JSON.stringify(value) + '\n');
  return { child, status, event, lines };
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

test('a child exit and the machine resources are logged, so a lost attempt leaves a trace', () => {
  const { child, event, lines } = childStatus();
  event({ event: 'declarations_progress', stage: 'extract', completed: 3 });
  child.emit('close', null, 'SIGTERM');
  assert.deepEqual(JSON.parse(lines.at(-1)), {
    event: 'declarations_child_exit',
    stage: 'extract',
    code: null,
    signal: 'SIGTERM',
  });
  const meminfo = 'MemTotal:       10485760 kB\nMemFree:  1 kB\nMemAvailable:    2097152 kB\n';
  const found = resources(meminfo);
  assert.equal(found.memoryTotalMb, 10240);
  assert.equal(found.memoryAvailableMb, 2048);
  assert.ok(found.diskFreeMb > 0);
});

test('a signal reaches the grandchild that does the work, not only the process it is sent to', async () => {
  // The platform signals the container's main process; the work sits two levels down (job → stage).
  const grandchild =
    'const c=require("child_process").spawn(process.execPath,["-e",' +
    '\'process.on("SIGTERM",()=>{console.log("stage-yielded");process.exit(75)});setInterval(()=>{},50)\'' +
    '],{stdio:["ignore","inherit","inherit"]});' +
    'process.on("SIGTERM",()=>{});c.on("close",(code)=>process.exit(code));';
  const child = spawn(process.execPath, ['-e', grandchild], {
    stdio: ['ignore', 'pipe', 'inherit'],
    detached: true,
  });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  await new Promise((done) => setTimeout(done, 300));
  process.kill(-child.pid, 'SIGTERM');
  const [code] = await once(child, 'close');
  assert.equal(code, 75);
  assert.match(out, /stage-yielded/);
});
