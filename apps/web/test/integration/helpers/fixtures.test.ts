import { describe, expect, it } from 'vitest';
import { buildContractsInsert, stripSqlCommentsAndCollapse } from './fixtures';

describe('stripSqlCommentsAndCollapse', () => {
  it('splits a multi-statement DDL file on semicolons and collapses whitespace', () => {
    const statements = stripSqlCommentsAndCollapse(
      `CREATE TABLE a (\n  id INTEGER PRIMARY KEY\n);\n-- a comment\nCREATE TABLE b (\n  id INTEGER\n);`,
    );
    expect(statements).toEqual([
      'CREATE TABLE a ( id INTEGER PRIMARY KEY )',
      'CREATE TABLE b ( id INTEGER )',
    ]);
  });

  it('drops full-line comments and trailing inline comments', () => {
    const statements = stripSqlCommentsAndCollapse(
      `SELECT 1; -- trailing\n-- whole line\nSELECT 2;`,
    );
    expect(statements).toEqual(['SELECT 1', 'SELECT 2']);
  });

  // Regression for PR #177 review T-004: the old per-line `--` strip ran BEFORE the string-aware
  // split, so a `--` inside a single-quoted string literal was treated as a comment start and the
  // rest of the literal (plus everything after) was silently dropped. A future migration or seed
  // row containing `'a--b'` would be corrupted. Comment stripping must be string-aware.
  it('does NOT treat -- inside a single-quoted string literal as a comment (string-aware strip)', () => {
    const statements = stripSqlCommentsAndCollapse(`INSERT INTO t (v) VALUES ('a--b');`);
    expect(statements).toEqual([`INSERT INTO t (v) VALUES ('a--b')`]);
  });

  it('does NOT treat -- inside a double-quoted identifier/string as a comment', () => {
    const statements = stripSqlCommentsAndCollapse(`INSERT INTO t (v) VALUES ("a--b");`);
    expect(statements).toEqual([`INSERT INTO t (v) VALUES ("a--b")`]);
  });

  it('still strips a real trailing comment that follows a closed string literal', () => {
    const statements = stripSqlCommentsAndCollapse(`INSERT INTO t (v) VALUES ('keep'); -- drop me`);
    expect(statements).toEqual([`INSERT INTO t (v) VALUES ('keep')`]);
  });

  // Regression for the second half of PR #177 review T-004: `replace(/\s+/g, ' ')` collapsed
  // significant whitespace inside string literals. Seed data with deliberate multi-space strings
  // must survive intact.
  it('preserves significant whitespace inside a single-quoted string literal', () => {
    const statements = stripSqlCommentsAndCollapse(`INSERT INTO t (v) VALUES ('a   b');`);
    expect(statements).toEqual([`INSERT INTO t (v) VALUES ('a   b')`]);
  });
});

describe('buildContractsInsert', () => {
  it('builds a single INSERT OR IGNORE with N rows keyed c:1..c:N', () => {
    const sql = buildContractsInsert(3);
    expect(sql.startsWith('INSERT OR IGNORE INTO contracts')).toBe(true);
    expect((sql.match(/'c:\d+'/g) ?? []).length).toBe(3);
    expect(sql).toContain("'c:1'");
    expect(sql).toContain("'c:3'");
  });
});
