// Adversarial unit tests for the fake-D1 gate (#325). Written before the gate itself: the whole
// point of the issue is that a test can go green while asserting nothing, so the gate that enforces
// it gets the same treatment as check-docs/check-coverage — its logic is pure and pinned here.
//
// Run: node --test scripts/check-fake-d1.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
  findCasts,
  findAliases,
  isScannable,
  staleAllowlistEntries,
  isMain,
  SCAN_ROOTS,
} from './check-fake-d1.mjs';

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

// ── the second axis: what gets scanned ─────────────────────────────────────────

test('SCAN_ROOTS covers both workspace roots', () => {
  // Without this, deleting 'apps' from the list leaves every test in the suite green while web and
  // etl quietly drop out of enforcement — a silent scope regression of exactly the kind #325 is
  // about. The pattern being right is only half the gate; the other half is where it is applied.
  assert.deepEqual([...SCAN_ROOTS].sort(), ['apps', 'packages']);
});

// ── aliasing: a cast the pattern cannot see ────────────────────────────────────

test('findAliases catches a local type alias — `as unknown as DBAlias` evades findCasts', () => {
  const hits = findAliases('type DBAlias = D1Database;\n');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);
  assert.match(hits[0].snippet, /DBAlias/);
  // The evasion itself: the cast that follows carries no D1Database token at all.
  assert.equal(findCasts('const db = {} as unknown as DBAlias;').length, 0);
});

test('findAliases catches a renamed type import', () => {
  const hits = findAliases("import type { D1Database as DB } from '@cloudflare/workers-types';\n");
  assert.equal(hits.length, 1);
  assert.match(hits[0].snippet, /D1Database as DB/);
});

test('findAliases catches an interface extending D1Database', () => {
  assert.equal(findAliases('interface Handle extends D1Database {}\n').length, 1);
});

test('findAliases catches an intersection, a mapped type and a namespaced import', () => {
  // Three spellings that name the type without the word `= D1Database` standing alone. Each was
  // verified to walk past the first pattern while the file itself was being scanned.
  assert.equal(findAliases('type Evade = D1Database & {};\n').length, 1);
  assert.equal(findAliases("type Picked = Pick<D1Database, 'prepare'>;\n").length, 1);
  assert.equal(
    findAliases("type Imported = import('@cloudflare/workers-types').D1Database;\n").length,
    1,
  );
});

test('findAliases catches a heritage clause that names D1Database anywhere in the list', () => {
  assert.equal(
    findAliases('interface Multi extends Record<string, unknown>, D1Database {}\n').length,
    1,
  );
});

test('findAliases leaves the type where it is a PARAMETER, not the alias itself', () => {
  // `type Params<F> = F extends (db: D1Database, …) => unknown ? … : …` is real code in
  // readonly-corpus.test.ts, and an `extends` inside a conditional type is not a heritage clause.
  // A gate that fires here is one somebody edits out.
  assert.deepEqual(
    findAliases(
      'type Params<F> = F extends (db: D1Database, p: infer P) => unknown ? P : never;\n',
    ),
    [],
  );
  assert.deepEqual(findAliases('type Loader = (db: D1Database) => Promise<void>;\n'), []);
});

test('findAliases leaves an ordinary annotation alone — the gate bans casts, not types', () => {
  // A binding declared as D1Database is how honest code names it. Flagging these would make the
  // gate fire on every Env type in the repo, and a gate that cries wolf gets weakened.
  assert.deepEqual(findAliases('type Env = { DB: D1Database };\n'), []);
  assert.deepEqual(findAliases('export function q(db: D1Database) {}\n'), []);
  assert.deepEqual(findAliases('let db: D1Database | undefined;\n'), []);
});

test('findAliases ignores an alias written in a comment or a string', () => {
  assert.deepEqual(findAliases('// type DBAlias = D1Database;\n'), []);
  assert.deepEqual(findAliases('const doc = "type DBAlias = D1Database";\n'), []);
});

test('findAliases reports the 1-based line of a hit further down the file', () => {
  const hits = findAliases('const a = 1;\n\ntype Handle = D1Database;\n');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
});
