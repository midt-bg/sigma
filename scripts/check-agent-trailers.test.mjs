// The agent-trailer guard, exercised against real commit ranges in this repository.
//
// A denylist check is worth exactly as much as its two failure modes: it must fire on the thing it
// exists for, and it must stay silent on the humans and dependency bots whose trailers are how their
// credit survives a squash merge. Both are asserted here against real history, not fixtures, because
// the interesting cases already exist on the remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SCRIPT = resolve(HERE, 'check-agent-trailers.mjs');

const run = (base, head) =>
  spawnSync(process.execPath, [SCRIPT, base, head], { cwd: ROOT, encoding: 'utf8' });

/** A commit that exists locally, or null — keeps the suite green on a shallow clone. */
function have(rev) {
  const r = spawnSync('git', ['rev-parse', '--verify', `${rev}^{commit}`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

test('a range with no agent trailers passes', (t) => {
  const head = have('HEAD');
  const base = have('HEAD~1');
  if (!base || !head) return t.skip('shallow clone');
  const r = run(base, head);
  assert.equal(r.status, 0, r.stderr);
});

test('a human co-author is NOT flagged', (t) => {
  // 8db751d carries `Co-authored-by: Bilko <StanislavBG@gmail.com>` — the exact shape that must
  // survive, since it is the only thing keeping his credit on main after the squash.
  const c = have('8db751d');
  if (!c) return t.skip('commit not present locally');
  const r = run(`${c}~1`, c);
  assert.equal(r.status, 0, `a human co-author was flagged:\n${r.stderr}`);
});

test('a dependency bot is NOT flagged', (t) => {
  // dependabot's trailer is how its own PRs are attributed. It is automation, not a coding agent.
  const c = have('0d9d0ad');
  if (!c) return t.skip('commit not present locally');
  const r = run(`${c}~1`, c);
  assert.equal(r.status, 0, `dependabot was flagged:\n${r.stderr}`);
});

test('an agent co-author IS flagged, and named in the output', (t) => {
  // PR #118 really does carry `Co-authored-by: Cursor <cursoragent@cursor.com>`. Fetched on demand so
  // the assertion is about a real contributor branch rather than a fixture written to match the regex.
  const fetched = spawnSync('git', ['fetch', '--quiet', '--depth=50', 'origin', 'pull/118/head'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (fetched.status !== 0) return t.skip('cannot reach the PR ref');
  const head = execFileSync('git', ['rev-parse', 'FETCH_HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  const base = execFileSync('git', ['rev-list', '--max-count=1', `${head}~40`], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  const r = run(base, head);
  assert.equal(r.status, 1, 'the Cursor trailer should have failed the check');
  assert.match(r.stderr, /Cursor/i);
  // The advice matters as much as the verdict: the fix must not send anyone at a contributor's fork
  // with a force push.
  assert.match(r.stderr, /gh pr merge --squash/);
});
