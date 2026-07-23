import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const loader = resolve(here, 'cacbg/register-ts.mjs');
const script = resolve(here, 'emit-refresh-group.mjs');

const emit = (group) =>
  execFileSync('node', ['--import', loader, script, group], {
    encoding: 'utf8',
    cwd: resolve(here, '..'),
  });

test('emits the entity-search-index group as runnable SQL (what the ETL cron runs)', () => {
  const out = emit('entity-search-index');
  // The officials INSERT is present, intact, and terminated — this is exactly the batch the reindex step
  // pipes into `wrangler d1 execute`, so a break here is a broken production reindex.
  assert.match(out, /INSERT INTO search_index[\s\S]*'official'/);
  assert.match(out, /GROUP BY il\.person_id, p\.name;/);
  // Every statement is semicolon-terminated (d1 execute --file needs terminators).
  assert.ok(out.trim().endsWith(';'), 'ends with a statement terminator');
});

test('unknown group name fails loudly (no silent empty reindex)', () => {
  assert.throws(
    () => emit('no-such-batch'),
    (e) => /no @refresh-batch group/.test(String(e.stderr)),
  );
});
