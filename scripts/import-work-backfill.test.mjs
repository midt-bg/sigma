// The work backfill's gate (scripts/import.mjs --work-db) runs the build-only checks, driven through the
// real script. A fake `node` stands in for the child loaders (load-eop, load-fx), so the build derives an
// empty corpus with the real sqlite3 and the real SQL, and the gate then reports on it: the empty corpus
// fails it, which is expected here, after every check has printed its line.
//
// Run: node --test scripts/import-work-backfill.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SCRIPT = resolve(HERE, 'import.mjs');

// The shebang names the real interpreter: `#!/usr/bin/env node` would find this very stub on PATH.
const FAKE = `#!${process.execPath}
process.exit(0);
`;

if (spawnSync('sqlite3', ['-version'], { stdio: 'ignore' }).error) {
  throw new Error('scripts/import-work-backfill.test.mjs requires the sqlite3 binary on PATH');
}

test('the work backfill gate proves the build against the value rule', () => {
  const dir = mkdtempSync(join(tmpdir(), 'work-backfill-'));
  try {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'package.json'), '{"type":"module"}');
    for (const name of ['node', 'wrangler']) {
      writeFileSync(join(binDir, name), FAKE);
      chmodSync(join(binDir, name), 0o755);
    }
    const res = spawnSync(
      process.execPath,
      [
        SCRIPT,
        `--work-db=${join(dir, 'work.sqlite')}`,
        '--from=2026-06-01',
        '--to=2026-06-01',
        '--no-ship',
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          SIGMA_D1_NAME: 'sigma-test-local',
        },
      },
    );
    assert.match(
      res.stdout,
      /\[ ok \] contract-value-rule: all 0 contracts carry what the value rule gives/,
    );
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /\(work backfill \(sqlite\)\): non-empty-corpus/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
