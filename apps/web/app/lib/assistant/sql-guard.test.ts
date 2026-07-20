import { describe, expect, it } from 'vitest';
import { assertReadOnlySelect, capRows, enforceLimit, MAX_ROWS } from './sql-guard';

describe('assertReadOnlySelect', () => {
  it('accepts a plain SELECT and a WITH…SELECT CTE', () => {
    expect(assertReadOnlySelect('SELECT * FROM contracts').ok).toBe(true);
    expect(assertReadOnlySelect('WITH t AS (SELECT 1 AS n) SELECT n FROM t').ok).toBe(true);
  });

  it('rejects write / DDL / dangerous statements', () => {
    for (const q of [
      'UPDATE contracts SET amount_eur = 0',
      'DELETE FROM contracts',
      'DROP TABLE contracts',
      'INSERT INTO contracts VALUES (1)',
      'PRAGMA table_info(contracts)',
      'ATTACH DATABASE x AS y',
      'CREATE TABLE t (a)',
    ]) {
      expect(assertReadOnlySelect(q).ok, q).toBe(false);
    }
  });

  it('rejects stacked statements even when the first is a SELECT', () => {
    const r = assertReadOnlySelect('SELECT 1; DROP TABLE contracts');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/single statement/);
  });

  it('accepts a semicolon inside a string literal (not a stacked statement, review #80)', () => {
    expect(assertReadOnlySelect("SELECT ';' AS note FROM contracts").ok).toBe(true);
    // a genuine stacked statement that merely contains a quoted ; is still rejected
    expect(assertReadOnlySelect("SELECT ';' AS note FROM contracts; DROP TABLE contracts").ok).toBe(
      false,
    );
  });

  it('treats a doubled-quote escape inside a literal as data (review #80)', () => {
    // SQLite escapes a quote by doubling it: 'O''Brien; Co' is the single value "O'Brien; Co",
    // so the embedded ; must not be read as a statement separator.
    expect(assertReadOnlySelect("SELECT 'O''Brien; Co' AS name FROM contracts").ok).toBe(true);
    // …and a real stacked statement following an escaped-quote literal is still rejected.
    expect(
      assertReadOnlySelect("SELECT 'O''Brien' AS name FROM contracts; DROP TABLE contracts").ok,
    ).toBe(false);
  });

  it('defeats comment-hidden injection (comments stripped before checks)', () => {
    expect(assertReadOnlySelect('SELECT 1 /* ; DROP TABLE contracts */').ok).toBe(true); // comment is inert
    expect(assertReadOnlySelect('SELECT 1; DROP/**/TABLE contracts').ok).toBe(false); // unmasked → rejected
    expect(assertReadOnlySelect('-- harmless\nSELECT 1').ok).toBe(true);
  });

  it('rejects a non-SELECT leading token', () => {
    expect(assertReadOnlySelect('EXPLAIN SELECT 1').ok).toBe(false);
  });

  it('rejects the table-valued pragma function form that \\bPRAGMA\\b misses (review #80)', () => {
    // `\bPRAGMA\b` does not match `pragma_table_info` (the `_` is a word char), so this is a separate guard.
    const r = assertReadOnlySelect("SELECT * FROM pragma_table_info('contracts')");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/pragma/i);
  });

  it('rejects json_each/json_tree/generate_series table-valued functions (review #80, ydimitrof H1)', () => {
    for (const sql of [
      "SELECT value FROM json_each('[1,2,3]')",
      "SELECT contract_id FROM (SELECT value AS contract_id FROM json_each('[1,2,3]')) x",
      'SELECT * FROM generate_series(1, 100)',
    ]) {
      expect(assertReadOnlySelect(sql).ok, sql).toBe(false);
    }
  });

  it('rejects dangerous scalar functions: load_extension and blob bombs (review #80, red-team R2)', () => {
    for (const sql of [
      "SELECT load_extension('evil')",
      'SELECT zeroblob(1000000000)',
      'SELECT randomblob(1000000000)',
      'SELECT hex(randomblob(500000000)) FROM contracts',
    ]) {
      const r = assertReadOnlySelect(sql);
      expect(r.ok, sql).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/function not allowed/);
    }
    // a legitimate aggregate/scalar query is untouched
    expect(
      assertReadOnlySelect('SELECT SUM(amount_eur), substr(signed_at,1,4) FROM contracts').ok,
    ).toBe(true);
  });

  it('allows the scalar REPLACE() function, still blocks the REPLACE INTO write (review #80)', () => {
    // REPLACE() is a safe read-only string function (e.g. Cyrillic↔Latin normalisation) — it must pass
    // the structural layer (the AST guard then confirms it is a SELECT).
    expect(assertReadOnlySelect("SELECT REPLACE(name, 'а', 'a') AS n FROM bidders").ok).toBe(true);
    // the bare REPLACE INTO write is still rejected — by the leading-token check (only SELECT/WITH lead).
    const w = assertReadOnlySelect('REPLACE INTO contracts VALUES (1)');
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.reason).toMatch(/SELECT or WITH/);
  });

  it('rejects printf/format string-width bombs (review #80, follow-up)', () => {
    // printf('%1000000d', x) builds a ~1 MB string per row that materialises before capRows can measure
    // it — the same memory-amplification class as randomblob/zeroblob, via functions the blocklist missed.
    for (const sql of [
      "SELECT printf('%1000000d', id) FROM contracts",
      "SELECT format('%1000000d', id) FROM contracts",
    ]) {
      const r = assertReadOnlySelect(sql);
      expect(r.ok, sql).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/function not allowed/);
    }
  });

  it('strips comments without corrupting string literals (review #80, follow-up)', () => {
    // A `/* */` or `--` INSIDE a single-quoted literal is data, not a comment: a literal-unaware strip
    // changed `'a/*b*/c'` to `'a c'` (wrong rows) and truncated `'x -- y'` (fail-closed false-deny).
    const a = assertReadOnlySelect("SELECT id FROM bidders WHERE name = 'a/*b*/c'");
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.sql).toContain("'a/*b*/c'");
    const b = assertReadOnlySelect("SELECT 'cost -- est' AS label, id FROM contracts");
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.sql).toContain("'cost -- est'");
    // a REAL trailing line comment is still stripped (single statement, leading SELECT preserved)
    expect(assertReadOnlySelect('SELECT id FROM contracts -- top earners').ok).toBe(true);
  });
});

describe('enforceLimit', () => {
  it('appends a LIMIT when none is present', () => {
    expect(enforceLimit('SELECT * FROM contracts')).toBe(
      `SELECT * FROM contracts LIMIT ${MAX_ROWS}`,
    );
  });
  it('leaves a within-bounds LIMIT untouched', () => {
    expect(enforceLimit('SELECT * FROM contracts LIMIT 10')).toBe(
      'SELECT * FROM contracts LIMIT 10',
    );
  });
  it('clamps an oversized LIMIT', () => {
    expect(enforceLimit('SELECT * FROM contracts LIMIT 999999')).toBe(
      `SELECT * FROM contracts LIMIT ${MAX_ROWS}`,
    );
  });
});

describe('capRows', () => {
  it('returns all rows when under the byte cap', () => {
    const { rows, truncated } = capRows(
      [
        [1, 'a'],
        [2, 'b'],
      ],
      10_000,
    );
    expect(rows).toHaveLength(2);
    expect(truncated).toBe(false);
  });
  it('truncates and flags when the byte budget is exceeded', () => {
    const big = Array.from({ length: 1000 }, (_, i) => [i, 'x'.repeat(100)]);
    const { rows, truncated } = capRows(big, 1024);
    expect(truncated).toBe(true);
    expect(rows.length).toBeLessThan(big.length);
  });
  it('keeps the first row even if it alone exceeds the cap (review #80, ultra #11)', () => {
    const huge = 'x'.repeat(200_000);
    const { rows, truncated } = capRows(
      [
        [1, huge],
        [2, 'b'],
      ],
      1024,
    );
    expect(rows).toHaveLength(1); // first row kept — not dropped to [] (a row:0 ref would then error)
    expect(rows[0]![0]).toBe(1);
    expect(truncated).toBe(true);
  });
});
