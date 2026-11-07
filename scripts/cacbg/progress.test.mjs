import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { stageExitCode } from './progress.mjs';

const child = (code) => spawnSync(process.execPath, ['-e', code]);

test('a stage that yields, or that the container stop kills, leaves the job with a yield', () => {
  assert.equal(stageExitCode(child('process.exit(75)')), 75);
  assert.equal(stageExitCode(child("process.kill(process.pid, 'SIGTERM')")), 75);
  assert.equal(stageExitCode(child("process.kill(process.pid, 'SIGINT')")), 75);
});

test('a stage that fails, or is killed for memory, leaves the job failed', () => {
  assert.equal(stageExitCode(child('process.exit(1)')), 1);
  assert.equal(stageExitCode(child('process.exit(2)')), 1);
  assert.equal(stageExitCode(child("process.kill(process.pid, 'SIGKILL')")), 1);
  assert.equal(stageExitCode(new Error('spawn failed')), 1);
});
