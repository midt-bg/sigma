// Adversarial unit tests for the fake-D1 gate (#325). Written before the gate itself: the whole
// point of the issue is that a test can go green while asserting nothing, so the gate that enforces
// it gets the same treatment as check-docs/check-coverage — its logic is pure and pinned here.
//
// Run: node --test scripts/check-fake-d1.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { findCasts, isScannable, staleAllowlistEntries, isMain } from './check-fake-d1.mjs';

test('findCasts finds a bare `as D1Database`', () => {
  const hits = findCasts('  } as D1Database;\n');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);
});

test('findCasts counts `as unknown as D1Database` ONCE — the longer spelling contains the shorter', () => {
  // The trap: /as D1Database/ matches inside "as unknown as D1Database", so a naive regex reports
  // two casts on one line and the gate's count is wrong from the first run.
  const hits = findCasts('} as unknown as D1Database;');
  assert.equal(hits.length, 1);
  assert.match(hits[0].snippet, /as unknown as D1Database/);
});

test('findCasts catches `satisfies D1Database` — the other operator that types a double', () => {
  assert.equal(findCasts('const db = { prepare } satisfies D1Database;').length, 1);
});

test('findCasts spans a line break between the operator and the type', () => {
  const hits = findCasts('const db = {\n  prepare,\n} as unknown as\n  D1Database;\n');
  assert.equal(hits.length, 1);
});

test('findCasts does not match a longer identifier that merely starts with D1Database', () => {
  assert.deepEqual(findCasts('s as D1DatabaseSession;'), []);
  assert.deepEqual(findCasts('s as D1DatabasePreparedStatement;'), []);
});

test('findCasts ignores a cast written inside a comment, not code', () => {
  assert.deepEqual(findCasts('// returns the handle as D1Database for callers\n'), []);
  assert.deepEqual(findCasts('/* historically `as unknown as D1Database` */\n'), []);
  assert.deepEqual(findCasts('/**\n * cast with as D1Database\n */\n'), []);
});

test('findCasts does not let a URL swallow the rest of the line', () => {
  // `//` inside https:// must not be treated as a line-comment start, or a real cast sitting after
  // a link on the same line would go unreported — the gate would fail OPEN.
  const hits = findCasts('const db = x as D1Database; // see https://example.com/d1\n');
  assert.equal(hits.length, 1);
});

test('findCasts reports the 1-based line of each hit across a multi-line file', () => {
  const hits = findCasts(
    ['const a = 1;', 'const b = x as D1Database;', '', 'const c = y as D1Database;'].join('\n'),
  );
  assert.deepEqual(
    hits.map((h) => h.line),
    [2, 4],
  );
});

test('isScannable accepts .ts/.tsx and rejects everything else', () => {
  assert.equal(isScannable('packages/db/src/queries/home.test.ts'), true);
  assert.equal(isScannable('apps/web/app/routes/search.test.tsx'), true);
  assert.equal(isScannable('packages/db/src/schema.sql'), false);
  assert.equal(isScannable('README.md'), false);
  assert.equal(isScannable('scripts/check-fake-d1.mjs'), false);
});

test('staleAllowlistEntries flags an entry whose file no longer exists', () => {
  // A stale entry must be an error, not a silent no-op: a deleted-then-renamed double would
  // otherwise leave the gate permanently widened by a path nobody reads. Same fail-closed
  // reasoning as validateBaseline in check-coverage.mjs.
  const allowed = ['packages/test-support/src/fake-d1.ts', 'packages/gone/src/old-double.ts'];
  const present = new Set(['packages/test-support/src/fake-d1.ts']);
  assert.deepEqual(staleAllowlistEntries(allowed, present), ['packages/gone/src/old-double.ts']);
});

test('staleAllowlistEntries is empty when every entry resolves', () => {
  const allowed = ['a.ts', 'b.ts'];
  assert.deepEqual(staleAllowlistEntries(allowed, new Set(['a.ts', 'b.ts', 'c.ts'])), []);
});

test('isMain is true only for the entry module, and survives an encoded path', () => {
  const url = pathToFileURL('/tmp/dir with space/check-fake-d1.mjs').href;
  assert.equal(isMain(url, '/tmp/dir with space/check-fake-d1.mjs'), true);
  assert.equal(isMain(url, '/tmp/other.mjs'), false);
  assert.equal(isMain(url, undefined), false);
});
