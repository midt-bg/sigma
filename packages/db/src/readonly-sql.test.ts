import { describe, expect, it } from 'vitest';
import { assertReadOnly, isReadOnlySql } from './readonly-sql';

// Statements that MUST be treated as writes (rejected). One row per construct. The CTE-prefixed and
// RETURNING rows are the bypasses a naive `^(select|with)` check would miss; the stacked and
// leading-comment rows exercise the literal-aware comment/statement splitting.
const WRITES: ReadonlyArray<readonly [label: string, sql: string]> = [
  ['INSERT', "INSERT INTO contracts (id) VALUES ('c:1')"],
  ['UPDATE', 'UPDATE contracts SET amount_eur = 0'],
  ['DELETE', 'DELETE FROM contracts'],
  ['REPLACE INTO', "REPLACE INTO contracts (id) VALUES ('c:1')"],
  ['CREATE TABLE', 'CREATE TABLE evil (id TEXT)'],
  ['DROP TABLE', 'DROP TABLE contracts'],
  ['ALTER TABLE', 'ALTER TABLE contracts ADD COLUMN evil TEXT'],
  ['PRAGMA', 'PRAGMA table_info(contracts)'],
  ['ATTACH', "ATTACH DATABASE 'x.db' AS x"],
  ['VACUUM', 'VACUUM'],
  ['REINDEX', 'REINDEX contracts'],
  ['CTE-scoped DELETE', 'WITH x AS (SELECT 1) DELETE FROM contracts'],
  ['CTE-scoped UPDATE', 'WITH x AS (SELECT 1) UPDATE contracts SET risk = 0'],
  ['CTE-scoped INSERT', 'WITH x AS (SELECT 1) INSERT INTO contracts SELECT * FROM x'],
  ['CTE-scoped REPLACE', 'WITH x AS (SELECT 1) REPLACE INTO contracts SELECT * FROM x'],
  ['INSERT RETURNING', "INSERT INTO contracts (id) VALUES ('c:1') RETURNING id"],
  ['stacked SELECT then DROP', 'SELECT 1; DROP TABLE contracts'],
  ['lowercase delete', 'delete from contracts'],
  ['mixed-case DeLeTe', 'DeLeTe FROM contracts'],
  ['leading line comment then DELETE', '-- note\nDELETE FROM contracts'],
  ['leading block comment then DELETE', '/* n */ DELETE FROM contracts'],
  ['leading whitespace then DELETE', '   \n\t DELETE FROM contracts'],
  ['EXPLAIN over a write', 'EXPLAIN DELETE FROM contracts'],
  ['load_extension side-effect fn', "SELECT load_extension('evil.so')"],
  ['writefile side-effect fn', "SELECT writefile('/tmp/x', 'data')"],
  ['readfile side-effect fn', "SELECT readfile('/etc/passwd')"],
  ['fts3_tokenizer pointer fn', "SELECT fts3_tokenizer('x', 1)"],
  // #225 review bypass: a `'` inside a quoted IDENTIFIER must not open a phantom string that hides the
  // trailing write. SQLite treats "x'"/`x'`/[x'] as identifiers and still executes the DELETE.
  [
    'quote in a "…" identifier hides DELETE',
    `WITH t("x'") AS (SELECT 1) DELETE FROM secrets WHERE x='y'`,
  ],
  [
    'quote in a `…` identifier hides DELETE',
    "WITH t(`x'`) AS (SELECT 1) DELETE FROM secrets WHERE x='y'",
  ],
  [
    'quote in a […] identifier hides DELETE',
    `WITH t([x']) AS (SELECT 1) DELETE FROM secrets WHERE x='y'`,
  ],
  ['empty', '   '],
];

// Real read-only shapes that MUST pass — including the literal/identifier cases a naive text blocklist
// (or an AST gate that fail-closes on unparsed-but-valid SQLite) would false-reject and 500 a live loader.
const READS: ReadonlyArray<readonly [label: string, sql: string]> = [
  ['plain SELECT', 'SELECT id FROM contracts'],
  ['WITH cte then SELECT', 'WITH t AS (SELECT id FROM contracts) SELECT id FROM t'],
  ['UNION', 'SELECT id FROM contracts UNION SELECT id FROM tenders'],
  ['subquery', 'SELECT id FROM contracts WHERE id IN (SELECT id FROM contracts LIMIT 1)'],
  ['EXPLAIN QUERY PLAN', 'EXPLAIN QUERY PLAN SELECT id FROM contracts'],
  ['write verb as a string literal', "SELECT id FROM contracts WHERE status = 'CREATE'"],
  ['DELETE as a string literal', "SELECT id FROM parties WHERE action = 'DELETE'"],
  ['semicolon + DROP inside a literal', "SELECT 'a; DROP TABLE t' AS demo"],
  ['write verb split across concatenated literals', "SELECT 'DEL' || 'ETE' AS x"],
  ['replace() scalar function', "SELECT replace(name, 'a', 'b') FROM parties"],
  [
    'updated_at / created_at columns (word-boundary)',
    'SELECT updated_at, created_at FROM contracts',
  ],
  ['lowercase select', 'select id from contracts'],
  ['leading line comment then SELECT', '-- note\nSELECT id FROM contracts'],
  // Quoted IDENTIFIERS equal to a write word are column/alias names, not writes — must not false-reject.
  ['"…" identifier equal to a write word', 'SELECT "DELETE" AS x FROM t'],
  ['`…` identifier equal to a write word', 'SELECT `UPDATE` FROM t'],
  ['[…] identifier equal to a write word', 'SELECT [DROP] FROM t'],
  ['doubled-quote escape inside an identifier', 'SELECT "a""b" FROM t'],
];

describe('isReadOnlySql — rejects writes', () => {
  it.each(WRITES)('rejects %s', (_label, sql) => {
    expect(isReadOnlySql(sql)).toBe(false);
  });
});

describe('isReadOnlySql — allows reads', () => {
  it.each(READS)('allows %s', (_label, sql) => {
    expect(isReadOnlySql(sql)).toBe(true);
  });
});

describe('assertReadOnly', () => {
  it('throws a read-only error for a write', () => {
    expect(() => assertReadOnly('DELETE FROM contracts')).toThrow(/read-only/i);
  });

  it('does not throw for a legitimate SELECT', () => {
    expect(() => assertReadOnly('SELECT id FROM contracts')).not.toThrow();
  });
});
