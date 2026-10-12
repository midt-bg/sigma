import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Run scripts/d1-file.sh against a stand-in `pnpm` that fails its first `failures` calls. */
function run(failures, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'd1-file-'));
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  writeFileSync(
    join(dir, 'pnpm'),
    `#!/usr/bin/env bash
echo "$*" >> "${calls}"
n=$(wc -l < "${calls}")
if [ "$n" -le ${failures} ]; then echo "✘ [ERROR] Not currently importing anything." >&2; exit 1; fi
echo "🌀 Processed 11 queries."
`,
  );
  chmodSync(join(dir, 'pnpm'), 0o755);
  const result = spawnSync('bash', ['scripts/d1-file.sh', 'sigma-test', '../../x.sql'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      D1_FILE_WAIT_SECONDS: '0',
      ...extraEnv,
    },
  });
  return { ...result, calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) };
}

test('applies the file through wrangler with the rendered config, once when it succeeds', () => {
  const r = run(0);
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, [
    '--filter @sigma/web exec wrangler d1 execute sigma-test --config wrangler.deploy.jsonc --remote --yes --file ../../x.sql',
  ]);
});

test('repeats a failed import and succeeds on a later attempt', () => {
  const r = run(2);
  assert.equal(r.status, 0);
  assert.equal(r.calls.length, 3);
  assert.match(r.stderr, /attempt 1\/3/);
  assert.match(r.stderr, /attempt 2\/3/);
});

test('fails the deploy only when every attempt fails', () => {
  const r = run(9);
  assert.equal(r.status, 1);
  assert.equal(r.calls.length, 3);
  assert.match(r.stderr, /::error::d1 execute --file \.\.\/\.\.\/x\.sql failed 3 times/);
  assert.equal(run(9, { D1_FILE_ATTEMPTS: '1' }).calls.length, 1);
});

test('the deploy sends every SQL file through the wrapper and syncs the curated list', () => {
  const deploy = readFileSync('.github/workflows/deploy.yml', 'utf8');
  const code = deploy
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(code, /--file/, 'a raw `d1 execute --file` bypasses the retry');
  assert.match(
    code,
    /d1-file\.sh "\$\{SIGMA_D1_NAME:-sigma\}" \.\.\/\.\.\/scripts\/seed-state-owned\.sql/,
  );
});
