import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const loader = resolve(here, 'cacbg/register-ts.mjs');
const script = resolve(here, 'emit-refresh-group.mjs');

const emit = (group, extraEnv = {}) =>
  execFileSync('node', ['--import', loader, script, group], {
    encoding: 'utf8',
    cwd: resolve(here, '..'),
    env: { ...process.env, ...extraEnv },
  });

test('emits the incremental official-search-index group as runnable SQL', () => {
  const out = emit('official-search-index');
  // The officials INSERT and touched-bidder scope are present and intact. This is exactly the batch the
  // ETL cron runs, so a break here either leaves stale amounts or restores the full-corpus D1 timeout.
  assert.match(out, /INSERT INTO search_index[\s\S]*'official'/);
  assert.match(out, /JOIN refresh_touched_bidders touched/);
  assert.match(out, /DROP TABLE refresh_official_reindex_scope;/);
  assert.match(out, /GROUP BY il\.person_id, p\.name;/);
  // Every statement is semicolon-terminated (d1 execute --file needs terminators).
  assert.ok(out.trim().endsWith(';'), 'ends with a statement terminator');
});

test('can scope the official reindex to explicit person ids for chunked publication', () => {
  const out = emit('official-search-index', {
    SIGMA_OFFICIAL_PERSON_IDS_JSON: JSON.stringify(['person-1', "person'2"]),
  });
  assert.match(
    out,
    /INSERT INTO refresh_official_reindex_scope \(person_id\) VALUES \('person-1'\),\('person''2'\);/,
  );
  assert.doesNotMatch(out, /JOIN refresh_touched_bidders touched/);
});

test('unknown group name fails loudly (no silent empty reindex)', () => {
  assert.throws(
    () => emit('no-such-batch'),
    (e) => /no @refresh-batch group/.test(String(e.stderr)),
  );
});
