import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LISTED = `Listing lifecycle rules for bucket 'b'...
name:     Default Multipart Abort Rule
enabled:  Yes
prefix:   (all prefixes)
action:   Abort incomplete multipart uploads after 7 days
`;
const CHECKPOINTS = `name:     checkpoints
enabled:  Yes
prefix:   declarations/corpus-v2/checkpoints/
action:   Expire objects after 7 days
`;

/** Run the script against a stand-in `pnpm` whose `lifecycle list` prints `listing` (or fails). */
function run({ listing = LISTED, listFails = false, addFails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'r2-lifecycle-'));
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  writeFileSync(join(dir, 'listing'), listing);
  writeFileSync(
    join(dir, 'pnpm'),
    `#!/usr/bin/env bash
echo "$*" >> "${calls}"
case "$*" in
  *"lifecycle list"*) ${listFails ? 'echo "Authentication error" >&2; exit 1' : `cat "${join(dir, 'listing')}"`} ;;
  *"lifecycle add"*) ${addFails ? 'exit 1' : 'exit 0'} ;;
esac
`,
  );
  chmodSync(join(dir, 'pnpm'), 0o755);
  const result = spawnSync('bash', ['scripts/ensure-r2-lifecycle.sh', 'sigma-declarations-test'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  const adds = readFileSync(calls, 'utf8')
    .split('\n')
    .filter((l) => l.includes('lifecycle add'));
  return { ...result, adds };
}

test('adds both rules to a bucket that has neither', () => {
  const r = run();
  assert.equal(r.status, 0);
  assert.deepEqual(r.adds, [
    '--filter @sigma/etl exec wrangler r2 bucket lifecycle add sigma-declarations-test --name checkpoints --prefix declarations/corpus-v2/checkpoints/ --expire-days 7 -y',
    '--filter @sigma/etl exec wrangler r2 bucket lifecycle add sigma-declarations-test --name fetch-events --prefix declarations/corpus-v2/fetch-events/ --expire-days 30 -y',
  ]);
});

test('leaves a rule that is already there alone', () => {
  const r = run({ listing: LISTED + CHECKPOINTS });
  assert.equal(r.status, 0);
  assert.equal(r.adds.length, 1);
  assert.match(r.adds[0], /--name fetch-events/);
  assert.match(r.stdout, /rule checkpoints already present/);
});

test('warns instead of failing the deploy when the rules cannot be read or added', () => {
  const unreadable = run({ listFails: true });
  assert.equal(unreadable.status, 0);
  assert.equal(unreadable.adds.length, 0);
  assert.match(unreadable.stdout, /::warning::Could not read the lifecycle rules/);
  const refused = run({ addFails: true });
  assert.equal(refused.status, 0);
  assert.match(refused.stdout, /::warning::Could not add the lifecycle rule checkpoints/);
});
