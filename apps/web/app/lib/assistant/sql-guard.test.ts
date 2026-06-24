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
});
