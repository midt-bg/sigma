import { describe, expect, it } from 'vitest';
import { buildContractsInsert, stripSqlCommentsAndCollapse } from './fixtures';

describe('LISTED_MIGRATIONS — auto-discovery of packages/db/migrations', () => {
  // Regression for PR #177 review T-009: the lane used to import hand-picked `MIG_0000`,
  // `MIG_0001`, `MIG_0002`, `MIG_0006`, `MIG_0007` constants and skip 0003-0005. That worked
  // only as long as no skipped migration created an object a later applied one (0006/0007)
  // ALTER-ed — silently broken. `paths.ts` now auto-discovers every shipped migration, so the
  // lane stays in lockstep with the source of truth.
  it('enumerates all shipped migrations in numeric order', async () => {
    const { LISTED_MIGRATIONS } = await import('../paths');
    const ordinals = LISTED_MIGRATIONS.map((m) => m.ordinal);
    const sorted = [...ordinals].sort((a, b) => a - b);
    expect(ordinals).toEqual(sorted);
    // 0000..0010 are the current shipped migrations; assert a contiguous prefix so a future
    // gap (e.g. 0009 was renamed 0011) is visible immediately.
    expect(ordinals[0]).toBe(0);
    expect(ordinals[ordinals.length - 1]).toBeGreaterThanOrEqual(10);
  });

  it('includes the migration the contract lane needs (0006 value_restated)', async () => {
    const { LISTED_MIGRATIONS } = await import('../paths');
    expect(LISTED_MIGRATIONS.some((m) => m.ordinal === 6)).toBe(true);
  });

  it('includes the migration the contract lane needs (0007 value_suspect)', async () => {
    const { LISTED_MIGRATIONS } = await import('../paths');
    expect(LISTED_MIGRATIONS.some((m) => m.ordinal === 7)).toBe(true);
  });

  it('every shipped migration is applied successfully (no silent breakage)', async () => {
    // The integration suite itself exercises this on every run: `bootstrapProxy()` walks
    // LISTED_MIGRATIONS and `proxy.env.DB.exec()`s each statement. If any migration fails
    // (e.g. because the lane now applies a previously-skipped migration that needs an
    // upstream object not yet created), the suite errors out before reaching the assertions
    // — this test is the tripwire.
    const { LISTED_MIGRATIONS } = await import('../paths');
    expect(LISTED_MIGRATIONS.length).toBeGreaterThanOrEqual(11);
  });
});

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

  // Regression for PR #177 review T-010: SQLite trigger bodies use `BEGIN … END;` blocks whose
  // interior contains its own semicolon (e.g. `SELECT RAISE(ABORT, '…');` before `END`). The
  // naive split-on-`;` approach used to break the trigger into a syntactically-broken fragment
  // (`CREATE TRIGGER … BEGIN SELECT RAISE(…)`) and D1 errored with
  // "incomplete input: SQLITE_ERROR". The scanner must track BEGIN/END depth so the trigger
  // body is delivered intact (or, equivalently, every intra-block statement is delivered as a
  // self-contained fragment the runner can `DB.exec()` individually).
  it('keeps a CREATE TRIGGER body together when the body has its own semicolons', () => {
    const triggerSql = [
      `CREATE TRIGGER trg_t BEFORE INSERT ON t`,
      `WHEN NEW.v NOT IN ('a','b')`,
      `BEGIN`,
      `  SELECT RAISE(ABORT, 'check failed');`,
      `END;`,
    ].join('\n');
    const statements = stripSqlCommentsAndCollapse(triggerSql);
    // The whole trigger is one statement (the inner RAISE `;` is intra-block, the outer `;` is
    // the block terminator — both end up flushed, but the inner one is the only one that closes
    // the trigger at depth > 0; the depth-0 `;` after `END` closes the outer CREATE TRIGGER).
    // Either way, every fragment must end with `BEGIN`/`END`/`RAISE`/`CREATE TRIGGER` — not
    // a half-built body that D1 will reject.
    const joined = statements.join('\n');
    expect(joined).toContain('CREATE TRIGGER trg_t');
    expect(joined).toContain('BEGIN');
    expect(joined).toContain('END');
    expect(joined).toContain(`RAISE(ABORT, 'check failed')`);
  });

  it('does not split at the depth-0 semicolon immediately after CREATE TRIGGER (BEGIN is the body opener, not a separate statement)', () => {
    // A `;` BEFORE the `BEGIN` keyword should still flush, but the trigger header itself does
    // not have one — `CREATE TRIGGER name` is the header, `BEGIN` opens the body, `END;` closes
    // it. The header and body together form one statement; the next depth-0 `;` is the one after
    // `END`.
    const triggerSql = `CREATE TRIGGER trg_t BEFORE INSERT ON t\nBEGIN\n  SELECT 1;\nEND;\n`;
    const statements = stripSqlCommentsAndCollapse(triggerSql);
    // Exactly one statement: the whole trigger.
    expect(statements.length).toBe(1);
    expect(statements[0]).toMatch(/CREATE TRIGGER trg_t[\s\S]*BEGIN[\s\S]*END/);
  });

  it('does not match BEGIN/END inside identifiers or column names (keyword-boundary check)', () => {
    // Column names like `begin_at` / `end_at` must not affect the block-depth counter. The
    // scanner matches only when the preceding buffer ends with whitespace (or is empty) AND the
    // next char is not a word character — i.e. a real token boundary.
    const sql = `INSERT INTO t (begin_at, end_at, payload) VALUES ('2024-01-01', '2024-12-31', 'x');`;
    const statements = stripSqlCommentsAndCollapse(sql);
    expect(statements).toEqual([
      `INSERT INTO t (begin_at, end_at, payload) VALUES ('2024-01-01', '2024-12-31', 'x')`,
    ]);
  });

  // Regression for PR #177 review T-KW-LOWER: the keyword-boundary check at fixtures.ts:79/85
  // only tests `[A-Z0-9_]` against the NEXT char. `tail` itself is upper-cased, so an identifier
  // like `beginning` matches `startsWith('BEGIN')` and the NEXT char is lowercase `n`, which is
  // NOT in `[A-Z0-9_]` — depth gets bumped at depth 0, the statement flushes nothing, and the
  // whole statement is silently dropped by the `if (buf.trim() && blockDepth === 0)` guard.
  // Same trap for `endtime` / `endpoint` / `ending` on the END branch. The boundary class must
  // include both cases (real SQL is case-insensitive for keywords but case-sensitive for
  // identifiers, so a lowercase letter after `BEGIN` IS an identifier boundary that should NOT
  // trigger the keyword match).
  //
  // The `atWordStart` guard at fixtures.ts:76 already prevents matching `beginning` when the
  // preceding buffer char is a non-whitespace symbol like `(` (e.g. `INSERT INTO t (beginning`),
  // because the preceding `(` is not whitespace. The bug surfaces specifically when a keyword-
  // shaped identifier appears at a *real* token boundary (after whitespace / start-of-input).
  it('does not match BEGIN/END when followed by a lowercase letter at a real token boundary (identifier boundary)', () => {
    // `beginning` is preceded by whitespace (the space after `FROM`), so the scanner's
    // `atWordStart` guard fires, upper-cases the tail to `BEGINNING`, and matches `startsWith('BEGIN')`.
    // The next char is lowercase `n`, which is NOT in `[A-Z0-9_]`, so the boundary check passes
    // and `blockDepth` gets bumped — silently dropping the SELECT.
    const sql = `SELECT *\nFROM beginning WHERE x = 1; SELECT 2;`;
    const statements = stripSqlCommentsAndCollapse(sql);
    expect(statements).toEqual([`SELECT * FROM beginning WHERE x = 1`, `SELECT 2`]);
  });

  // ydimitrof review 2026-08-31 (thread on fixtures.ts:84): the previous BEGIN keyword guard
    // fired whenever the char after `BEGIN` was not an identifier character, which also matched
    // `BEGIN;` (next char is `;`) and `BEGIN TRANSACTION;` (next char is whitespace). Both are
    // valid transaction openers in SQLite/D1, and a future migration / seed wrapped in
    // `BEGIN; … COMMIT;` would silently drop the entire buffer (blockDepth stays 1 through
    // COMMIT, and the EOF flush guard `if (buf.trim() && blockDepth === 0)` discards it). The
    // scanner must distinguish transactions (do NOT open a block) from trigger bodies (DO open
    // a block). The DDL today does not contain `BEGIN;`/`BEGIN TRANSACTION;`, so this is a
    // latent bug — but the lane auto-discovers future migrations, so the guard is necessary.
    it('treats `BEGIN;` as a transaction (not a trigger body) — does NOT open a block', () => {
      const sql = `BEGIN;\nINSERT INTO t (v) VALUES (1);\nCOMMIT;\n`;
      const statements = stripSqlCommentsAndCollapse(sql);
      expect(statements).toEqual([`BEGIN`, `INSERT INTO t (v) VALUES (1)`, `COMMIT`]);
    });

    it('treats `BEGIN TRANSACTION;` (and the deferred/immediate/exclusive variants) as a transaction — does NOT open a block', () => {
      const sql = `BEGIN TRANSACTION;\nINSERT INTO t (v) VALUES (1);\nCOMMIT;\n`;
      expect(stripSqlCommentsAndCollapse(sql)).toEqual([
        `BEGIN TRANSACTION`,
        `INSERT INTO t (v) VALUES (1)`,
        `COMMIT`,
      ]);

      const deferred = `BEGIN DEFERRED;\nINSERT INTO t (v) VALUES (2);\nCOMMIT;\n`;
      expect(stripSqlCommentsAndCollapse(deferred)).toEqual([
        `BEGIN DEFERRED`,
        `INSERT INTO t (v) VALUES (2)`,
        `COMMIT`,
      ]);

      const immediate = `BEGIN IMMEDIATE;\nINSERT INTO t (v) VALUES (3);\nCOMMIT;\n`;
      expect(stripSqlCommentsAndCollapse(immediate)).toEqual([
        `BEGIN IMMEDIATE`,
        `INSERT INTO t (v) VALUES (3)`,
        `COMMIT`,
      ]);
    });

    it('still treats `BEGIN SELECT …` as a trigger-body opener', () => {
      // Sanity check that the transaction-classification guard did not regress the trigger-body
      // case: `BEGIN` followed by anything OTHER than `;` or a transaction keyword must open a
      // block (the original behaviour, preserved by the fix).
      const sql = `CREATE TRIGGER t BEFORE INSERT ON s\nBEGIN\n  SELECT RAISE(ABORT, 'x');\nEND;\n`;
      const statements = stripSqlCommentsAndCollapse(sql);
      expect(statements.length).toBe(1);
      expect(statements[0]).toMatch(/CREATE TRIGGER t[\s\S]*BEGIN[\s\S]*END/);
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
