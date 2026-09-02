import { describe, expect, it } from 'vitest';
import { recordingD1 } from '@sigma/test-support';
import {
  acquireRefreshLease,
  createTransientStaging,
  dropTransientStaging,
  dropTransientStagingStatements,
  pendingTouchedRows,
  refreshDerivedContractCount,
  refreshSliceStatementGroups,
  releaseRefreshLease,
  renewRefreshLease,
  runRefreshSliceStatementGroup,
  splitSqlStatements,
  transientStagingStatements,
} from './refresh';

// Capturing D1 over the shared recording double. refresh.ts hands D1 whole bundled SQL files, so
// marker routing has nothing to route on — recordingD1 is the shape for a wrapper like this: it
// accepts any statement and logs it. What the tests need on top is the batch GROUPING (which
// statements went out together), which the flat call log does not preserve, so batch() is wrapped
// to slice the log at each call. Wrapping, not re-implementing: the double still owns the surface.
function fakeDb(firstResult: { n: number } | null = { n: 0 }): {
  db: D1Database;
  batches: string[][];
} {
  const fake = recordingD1([{ when: [], first: firstResult }]);
  const batches: string[][] = [];
  // Batch groups come from the PREPARE log, not the batch log: batch() re-records each statement
  // under via:'batch' without its binds (prepare() already logged those), and the binds are half of
  // what these tests assert. Prepared statements are consumed by successive batches in order.
  const inner = fake.db.batch.bind(fake.db);
  let consumed = 0;
  fake.db.batch = (async (statements: D1PreparedStatement[]) => {
    const results = await inner(statements);
    const prepared = fake.calls.filter((c) => c.via === 'prepare');
    batches.push(prepared.slice(consumed, consumed + statements.length).map((c) => c.sql));
    consumed += statements.length;
    return results;
  }) as typeof fake.db.batch;
  return { db: fake.db, batches };
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
    // [...scratch, ...current, ...legacy].reverse() → legacy first, then current back-to-front, and
    // the derive-step scratch tables last.
    expect(dropTransientStagingStatements()).toEqual([
      'DROP TABLE IF EXISTS raw_egov_amendments',
      'DROP TABLE IF EXISTS raw_egov_tenders',
      'DROP TABLE IF EXISTS raw_egov_contracts',
      'DROP TABLE IF EXISTS raw_ocds_lots',
      'DROP TABLE IF EXISTS raw_ocds_parties',
      'DROP TABLE IF EXISTS raw_amendments',
      'DROP TABLE IF EXISTS raw_tenders',
      'DROP TABLE IF EXISTS raw_contracts',
      'DROP TABLE IF EXISTS amend_contract_base',
      'DROP TABLE IF EXISTS amendment_contract_resolve',
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

// The Worker asks this before short-circuiting an empty window: "did an earlier run die with rollups
// still owed?" Absent tables are the normal post-clean-run state and must read as zero, not throw.
describe('pendingTouchedRows', () => {
  it('reads zero — and asks nothing else — when no touched table exists', async () => {
    const fake = recordingD1([{ when: ['sqlite_master'], all: [] }]);
    await expect(pendingTouchedRows(fake.db)).resolves.toEqual({
      contracts: 0,
      bidders: 0,
      authorities: 0,
      total: 0,
    });
    expect(fake.calls.filter((c) => /COUNT\(\*\)/.test(c.sql))).toEqual([]);
  });

  it('reads a present table whose COUNT comes back without a row as zero', async () => {
    const fake = recordingD1([
      { when: ['sqlite_master'], all: [{ name: 'refresh_touched_bidders' }] },
      { when: ['FROM refresh_touched_bidders'], first: null },
    ]);
    await expect(pendingTouchedRows(fake.db)).resolves.toEqual({
      contracts: 0,
      bidders: 0,
      authorities: 0,
      total: 0,
    });
  });

  it('counts each existing touched table and sums them', async () => {
    const fake = recordingD1([
      {
        when: ['sqlite_master'],
        all: [{ name: 'refresh_touched_contracts' }, { name: 'refresh_touched_authorities' }],
      },
      { when: ['FROM refresh_touched_contracts'], first: { n: 3 } },
      { when: ['FROM refresh_touched_authorities'], first: { n: 1 } },
    ]);
    await expect(pendingTouchedRows(fake.db)).resolves.toEqual({
      contracts: 3,
      bidders: 0, // the table is absent, so it is never queried
      authorities: 1,
      total: 4,
    });
    expect(fake.calls.some((c) => c.sql.includes('FROM refresh_touched_bidders'))).toBe(false);
    // The existence probe binds the table names rather than interpolating them.
    const probe = fake.calls.find((c) => c.sql.includes('sqlite_master'));
    expect(probe?.binds).toEqual([
      'refresh_touched_contracts',
      'refresh_touched_bidders',
      'refresh_touched_authorities',
    ]);
  });
});

// The lease is one atomic batch (create-if-absent, conditional upsert) plus a read-back, and the verdict
// is read from the row, never assumed from the upsert — D1 does not report whether DO UPDATE's WHERE
// fired. These pin the SQL contract; the real conditional semantics run on SQLite in apps/etl.
describe('refresh lease', () => {
  const NOW = new Date('2026-09-02T19:16:00.000Z');

  it('acquires when the read-back names this holder, and binds holder/acquired/expires', async () => {
    const fake = recordingD1([
      {
        when: ['FROM refresh_lease'],
        first: { holder: 'wf-1', expires_at: '2026-09-02T19:46:00.000Z' },
      },
    ]);
    await expect(acquireRefreshLease(fake.db, 'wf-1', NOW)).resolves.toEqual({
      acquired: true,
      holder: 'wf-1',
      expiresAt: '2026-09-02T19:46:00.000Z',
    });
    const upsert = fake.calls.find((c) => c.sql.includes('INSERT INTO refresh_lease'));
    expect(upsert?.binds).toEqual(['wf-1', '2026-09-02T19:16:00.000Z', '2026-09-02T19:46:00.000Z']);
    expect(upsert?.sql).toMatch(
      /WHERE refresh_lease\.expires_at <= \?2 OR refresh_lease\.holder = \?1/,
    );
    expect(fake.calls.some((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS refresh_lease'))).toBe(
      true,
    );
    // create + conditional upsert go out as ONE batch; the verdict is a separate read-back
    expect(fake.calls.filter((c) => c.via === 'batch')).toHaveLength(2);
    expect(
      fake.calls.filter((c) => c.via === 'batch').some((c) => c.sql.includes('FROM refresh_lease')),
    ).toBe(false);
  });

  it('reports the live competitor when the read-back names someone else', async () => {
    const fake = recordingD1([
      {
        when: ['FROM refresh_lease'],
        first: { holder: 'wf-0', expires_at: '2026-09-02T19:40:00.000Z' },
      },
    ]);
    await expect(acquireRefreshLease(fake.db, 'wf-1', NOW)).resolves.toEqual({
      acquired: false,
      holder: 'wf-0',
      expiresAt: '2026-09-02T19:40:00.000Z',
    });
  });

  it('treats a missing row as not acquired rather than as ours', async () => {
    const fake = recordingD1([{ when: ['FROM refresh_lease'], first: null }]);
    await expect(acquireRefreshLease(fake.db, 'wf-1', NOW)).resolves.toEqual({
      acquired: false,
      holder: null,
      expiresAt: null,
    });
  });

  it('renews only its own row and reads the verdict back', async () => {
    const fake = recordingD1([
      { when: ['UPDATE refresh_lease'], run: () => {} },
      {
        when: ['FROM refresh_lease'],
        first: { holder: 'wf-1', expires_at: '2026-09-02T19:50:00.000Z' },
      },
    ]);
    await expect(
      renewRefreshLease(fake.db, 'wf-1', new Date('2026-09-02T19:20:00.000Z')),
    ).resolves.toEqual({
      acquired: true,
      holder: 'wf-1',
      expiresAt: '2026-09-02T19:50:00.000Z',
    });
    const upd = fake.calls.find((c) => c.sql.includes('UPDATE refresh_lease'));
    expect(upd?.sql).toMatch(/WHERE id = 1 AND holder = \?1/);
    expect(upd?.binds).toEqual(['wf-1', '2026-09-02T19:50:00.000Z']);
  });

  it('treats a vanished lease row on renewal as lost, not as ours', async () => {
    const fake = recordingD1([
      { when: ['UPDATE refresh_lease'], run: () => {} },
      { when: ['FROM refresh_lease'], first: null },
    ]);
    await expect(renewRefreshLease(fake.db, 'wf-1')).resolves.toEqual({
      acquired: false,
      holder: null,
      expiresAt: null,
    });
  });

  it('reports a lost lease when the read-back names a newer holder', async () => {
    const fake = recordingD1([
      { when: ['UPDATE refresh_lease'], run: () => {} },
      {
        when: ['FROM refresh_lease'],
        first: { holder: 'wf-2', expires_at: '2026-09-02T20:10:00.000Z' },
      },
    ]);
    await expect(renewRefreshLease(fake.db, 'wf-1')).resolves.toEqual({
      acquired: false,
      holder: 'wf-2',
      expiresAt: '2026-09-02T20:10:00.000Z',
    });
  });

  it('releases only its own lease', async () => {
    const fake = recordingD1([{ when: ['DELETE FROM refresh_lease'], run: () => {} }]);
    await releaseRefreshLease(fake.db, 'wf-1');
    const del = fake.calls.find((c) => c.sql.includes('DELETE FROM refresh_lease'));
    expect(del?.sql).toMatch(/WHERE id = 1 AND holder = \?/);
    expect(del?.binds).toEqual(['wf-1']);
  });
});
