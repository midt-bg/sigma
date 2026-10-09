/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SEARCH_HITS_SQL_NO_CONFLICT, searchMatchQuery } from './queries/search';

// Integration test for the REAL search ranking SQL (SEARCH_HITS_SQL_NO_CONFLICT, imported from
// queries/search.ts — not a hand-copied mirror) against a real SQLite FTS5 search_index built from
// the base migration only. Regression coverage for issue #25: an authority/company whose title
// repeats the query terms several times (e.g. a municipality name field concatenating several
// child-entity names) must not outrank an entity whose title is an exact, single match.
// search.test.ts's unit tests fake D1 and never run real FTS5 ranking, so they can't catch this.
// Mirrors the sqlite3-CLI harness of amendments-sql.test.ts / competition-sql.test.ts. Uses the
// NO_CONFLICT variant deliberately: this suite is about rank ordering over `authority` rows, not the
// свързани-лица conflict join (covered by search-sql.test.ts), so it only needs migration 0000 — both
// variants share the identical CANDIDATES/tie-break structure the ranking assertions below exercise.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migration0 = resolve(root, 'packages/db/migrations/0000_init.sql');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' }).trim();
}
function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
}
function withDb<T>(fn: (dbPath: string) => T): T {
  const dir = mkdtempSync(resolve(tmpdir(), 'sigma-search-index-'));
  const dbPath = resolve(dir, 'test.sqlite');
  try {
    readScript(dbPath, migration0);
    return fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function insertAuthorityRows(dbPath: string, rows: [ref: string, title: string][]): void {
  const values = rows
    .map(([ref, title]) => `('authority', '${ref}', '${title.replace(/'/g, "''")}', '', NULL, 0)`)
    .join(',\n');
  sqlite(
    dbPath,
    `INSERT INTO search_index (kind, ref, title, ident, subtitle, amount) VALUES ${values};`,
  );
}

// Substitutes each `?` placeholder in order with a literal SQL value. Uses a function replacer
// (not a plain string) because `String.prototype.replace` treats `$` sequences in a string
// replacement specially (`$&`, `$'`, ...) — a bound value containing `$` would otherwise corrupt
// the substitution instead of being inserted literally.
function bindParams(sql: string, params: string[]): string {
  return params.reduce((acc, value) => acc.replace('?', () => value), sql);
}

// Runs the real production ORDER BY against a real FTS5 table, split on the pipe-delimited columns
// sqlite3 prints them as: ref, title, ident, subtitle, amount, entity_kind, ownership_kind, eik_valid.
function rankedRows(dbPath: string, query: string): string[][] {
  const match = searchMatchQuery(query);
  const sql = bindParams(SEARCH_HITS_SQL_NO_CONFLICT, ["'authority'", `'${match}'`, '10']);
  const out = sqlite(dbPath, sql);
  if (out === '') return [];
  return out.split('\n').map((line) => line.split('|'));
}

function rankedTitles(dbPath: string, query: string): string[] {
  return rankedRows(dbPath, query).map((cols) => cols[1] ?? '');
}

function rankedRefs(dbPath: string, query: string): string[] {
  return rankedRows(dbPath, query).map((cols) => cols[0] ?? '');
}

describe('search ranking SQL (real SQLite FTS5, SEARCH_HITS_SQL_NO_CONFLICT)', () => {
  it('ranks exact, single-match titles above a title that repeats the query terms several times (#25)', () => {
    withDb((dbPath) => {
      insertAuthorityRows(dbPath, [
        [
          'auth:blob',
          'Община Лясковец - детска градина Сладкопойна чучулига, детска градина Детелина, детска градина Славейче',
        ],
        ['auth:clean1', 'Детска градина Слънце'],
        ['auth:clean2', 'Детска градина Дъга'],
      ]);

      const titles = rankedTitles(dbPath, 'детска градина');

      expect(titles).toHaveLength(3);
      const blobRank = titles.indexOf(
        'Община Лясковец - детска градина Сладкопойна чучулига, детска градина Детелина, детска градина Славейче',
      );
      const clean1Rank = titles.indexOf('Детска градина Слънце');
      const clean2Rank = titles.indexOf('Детска градина Дъга');

      expect(clean1Rank).toBeLessThan(blobRank);
      expect(clean2Rank).toBeLessThan(blobRank);
    });
  });

  it('does not sink a legitimate longer single-match title below an unrelated exact match', () => {
    withDb((dbPath) => {
      insertAuthorityRows(dbPath, [
        ['auth:long', 'Общинска детска градина за изкуство №5 към Столична община район Витоша'],
        ['auth:short', 'Детска градина Дъга'],
      ]);

      const titles = rankedTitles(dbPath, 'детска градина');

      // Both are single, clean matches. The dampening does put the shorter one first — that is its
      // job — but the longer descriptive title must stay a top hit rather than being buried. Asserted
      // as the EXACT order: `arrayContaining` would pass no matter how the two are ordered (both rows
      // come back under LIMIT 10 regardless), so it could not detect the regression it guards against.
      expect(titles).toEqual([
        'Детска градина Дъга',
        'Общинска детска градина за изкуство №5 към Столична община район Витоша',
      ]);
    });
  });

  // The ordering above can be satisfied by ordering the whole match set — which is exactly the
  // regression to prevent. `ORDER BY rank` is the only form FTS5 optimizes (rank-ordering index +
  // LIMIT pushdown); ordering by an expression over rank degrades to materializing and sorting every
  // matching row. On „община"-class terms that is tens of thousands of rows per keystroke, and D1
  // bills rows read. Lock the plan so a later simplification back to a single-level query is caught.
  it('drives the match with FTS5 rank ordering, not a full sort of every match', () => {
    withDb((dbPath) => {
      insertAuthorityRows(dbPath, [['auth:1', 'Община Ботевград']]);
      const sql = bindParams(SEARCH_HITS_SQL_NO_CONFLICT, [
        "'authority'",
        `'${searchMatchQuery('ботевград')}'`,
        '6',
      ]);
      const plan = sqlite(dbPath, `EXPLAIN QUERY PLAN ${sql}`);

      // idx 32 is FTS5's "ordering by rank" flag; idx 0 means it fell back to an unordered scan.
      expect(plan).toMatch(/VIRTUAL TABLE INDEX 32/);
      expect(plan).not.toMatch(/VIRTUAL TABLE INDEX 0/);
    });
  });

  it('substitutes a value containing `$` literally, not as a replace() special sequence', () => {
    // A plain string replacement would interpret `$&`/`$'` in the bound value instead of inserting
    // it verbatim — bindParams uses a function replacer specifically to avoid that.
    expect(bindParams('WHERE a = ? AND b = ?', ["'$&'", "'$'"])).toBe("WHERE a = '$&' AND b = '$'");
  });

  it('breaks ties on `h.ref` so equal-rank, equal-length titles order deterministically', () => {
    withDb((dbPath) => {
      // Same title text (and thus identical rank and identical LENGTH(title)) on two rows can only
      // be ordered by the secondary sort key, h.ref.
      insertAuthorityRows(dbPath, [
        ['auth:zzz', 'Детска градина Дъга'],
        ['auth:aaa', 'Детска градина Дъга'],
      ]);

      const refs = rankedRefs(dbPath, 'детска градина');

      expect(refs).toEqual(['auth:aaa', 'auth:zzz']);
    });
  });
});
