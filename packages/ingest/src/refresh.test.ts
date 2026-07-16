import { describe, expect, it } from 'vitest';
import {
  createTransientStaging,
  dropTransientStaging,
  dropTransientStagingStatements,
  refreshDerivedContractCount,
  refreshSliceStatementGroups,
  runRefreshSliceStatementGroup,
  splitSqlStatements,
  transientStagingStatements,
} from './refresh';

// Capturing D1: records each batch as the list of prepared SQL strings, and lets a test pin what
// `.first()` returns. The refresh layer only prepares/batches statements, so capturing them verifies
// the real behaviour (order, grouping, scope).
function fakeDb(firstResult: { n: number } | null = { n: 0 }): {
  db: D1Database;
  batches: string[][];
} {
  const batches: string[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        sql,
        bind() {
          return this;
        },
        async first() {
          return firstResult;
        },
      };
    },
    async batch(stmts: Array<{ sql: string }>) {
      batches.push(stmts.map((s) => s.sql));
      return stmts.map(() => ({ success: true, meta: {} }));
    },
  } as unknown as D1Database;
  return { db, batches };
}

describe('splitSqlStatements', () => {
  it('splits on semicolons outside string literals and trims', () => {
    expect(splitSqlStatements('SELECT 1;\nSELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('keeps the trailing statement that has no terminating semicolon', () => {
    expect(splitSqlStatements('SELECT 1;\nSELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('drops empty statements from doubled or trailing semicolons', () => {
    expect(splitSqlStatements('SELECT 1;;\n;')).toEqual(['SELECT 1']);
    expect(splitSqlStatements('   ')).toEqual([]);
  });

  it('strips -- line comments outside literals but keeps them inside', () => {
    expect(splitSqlStatements('SELECT 1; -- a note\nSELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
    // a -- inside a string literal is data, not a comment
    expect(splitSqlStatements("SELECT '-- not a comment';")).toEqual(["SELECT '-- not a comment'"]);
  });

  it('does not split on a semicolon inside a string literal', () => {
    expect(splitSqlStatements("INSERT INTO t VALUES ('a; b');")).toEqual([
      "INSERT INTO t VALUES ('a; b')",
    ]);
  });

  it('treats a doubled single-quote as an escaped quote, staying in the literal', () => {
    // The `;` lives inside the literal because the '' does not close it.
    expect(splitSqlStatements("SELECT 'it''s; fine';")).toEqual(["SELECT 'it''s; fine'"]);
  });

  it('handles a comment that runs to end-of-input without a newline', () => {
    expect(splitSqlStatements('SELECT 1; -- trailing comment no newline')).toEqual(['SELECT 1']);
  });
});

describe('refreshSliceStatementGroups', () => {
  it('returns a single derive-slice group when there are no batch markers', () => {
    const groups = refreshSliceStatementGroups('SELECT 1;\nSELECT 2;');
    expect(groups).toEqual([{ name: 'derive-slice', statements: ['SELECT 1', 'SELECT 2'] }]);
  });

  it('splits into named groups at each -- @refresh-batch marker', () => {
    const sql = [
      'SELECT 0;',
      '-- @refresh-batch rollups',
      'SELECT 1;',
      'SELECT 2;',
      '-- @refresh-batch health',
      'SELECT 3;',
    ].join('\n');
    const groups = refreshSliceStatementGroups(sql);
    expect(groups).toEqual([
      { name: 'derive-slice', statements: ['SELECT 0'] },
      { name: 'rollups', statements: ['SELECT 1', 'SELECT 2'] },
      { name: 'health', statements: ['SELECT 3'] },
    ]);
  });

  it('skips a marker group that contains no statements', () => {
    const sql = '-- @refresh-batch empty\n-- @refresh-batch real\nSELECT 1;';
    expect(refreshSliceStatementGroups(sql)).toEqual([{ name: 'real', statements: ['SELECT 1'] }]);
  });

  it('falls back to one derive-slice group for statement-less input', () => {
    expect(refreshSliceStatementGroups('')).toEqual([{ name: 'derive-slice', statements: [] }]);
  });

  it('is case-insensitive on the marker and accepts hyphenated names', () => {
    const groups = refreshSliceStatementGroups('-- @REFRESH-BATCH my-batch\nSELECT 1;');
    expect(groups).toEqual([{ name: 'my-batch', statements: ['SELECT 1'] }]);
  });
});

describe('transient staging statements', () => {
  it('keeps only statements that touch a transient staging table', () => {
    const schema = [
      'CREATE TABLE raw_contracts (id TEXT);',
      'CREATE TABLE authorities (id TEXT);', // permanent — must be filtered out
      'CREATE TABLE raw_ocds_lots (id TEXT);',
    ].join('\n');
    expect(transientStagingStatements(schema)).toEqual([
      'CREATE TABLE raw_contracts (id TEXT)',
      'CREATE TABLE raw_ocds_lots (id TEXT)',
    ]);
  });

  it('drops every transient + legacy table in reverse of the declared order', () => {
    // [...current, ...legacy].reverse() → legacy first, then current back-to-front.
    expect(dropTransientStagingStatements()).toEqual([
      'DROP TABLE IF EXISTS raw_egov_amendments',
      'DROP TABLE IF EXISTS raw_egov_tenders',
      'DROP TABLE IF EXISTS raw_egov_contracts',
      'DROP TABLE IF EXISTS raw_ocds_lots',
      'DROP TABLE IF EXISTS raw_ocds_parties',
      'DROP TABLE IF EXISTS raw_amendments',
      'DROP TABLE IF EXISTS raw_tenders',
      'DROP TABLE IF EXISTS raw_contracts',
    ]);
  });
});

describe('D1 orchestration', () => {
  it('createTransientStaging drops first, then creates only the transient tables', async () => {
    const { db, batches } = fakeDb();
    const schema = 'CREATE TABLE raw_contracts (id TEXT);\nCREATE TABLE authorities (id TEXT);';
    await createTransientStaging(db, schema);
    expect(batches).toHaveLength(2);
    expect(batches[0]!.every((s) => s.startsWith('DROP TABLE IF EXISTS'))).toBe(true);
    expect(batches[1]).toEqual(['CREATE TABLE raw_contracts (id TEXT)']); // authorities filtered
  });

  it('dropTransientStaging issues exactly one batch of DROPs', async () => {
    const { db, batches } = fakeDb();
    await dropTransientStaging(db);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(dropTransientStagingStatements());
  });

  it('runRefreshSliceStatementGroup batches a group verbatim', async () => {
    const { db, batches } = fakeDb();
    await runRefreshSliceStatementGroup(db, { name: 'g', statements: ['SELECT 1', 'SELECT 2'] });
    expect(batches).toEqual([['SELECT 1', 'SELECT 2']]);
  });

  it('refreshDerivedContractCount returns the counted rows', async () => {
    const { db } = fakeDb({ n: 42 });
    expect(await refreshDerivedContractCount(db)).toBe(42);
  });

  it('refreshDerivedContractCount coalesces a null result to 0', async () => {
    const { db } = fakeDb(null);
    expect(await refreshDerivedContractCount(db)).toBe(0);
  });
});
