import { describe, expect, it } from 'vitest';
import { recordingD1, type FakeD1Call } from '@sigma/test-support';
import { BASE_AMENDMENT_COLS, BASE_CONTRACT_COLS, BASE_TENDER_COLS } from './base';
import {
  AMENDMENT_STAGING_COLS,
  CONTRACT_STAGING_COLS,
  LOT_STAGING_COLS,
  PARTY_STAGING_COLS,
} from './ocds';
import {
  upsertAmendmentStaging,
  upsertBaseAmendmentStaging,
  upsertBaseContractStaging,
  upsertBaseTenderStaging,
  upsertContractStaging,
  upsertLotStaging,
  upsertPartyStaging,
} from './staging';

// Capturing D1 over the shared recording double. The staging layer's whole job is statement
// construction (scoped DELETE, chunked INSERTs, null-fill) against arbitrary generated SQL, so there
// is nothing for marker routing to route on — recordingD1 is the shape for that: it accepts any
// statement and logs it with its binds. Only the batch GROUPING (which statements went out together,
// and how many batches there were) is missing from the flat log, so batch() is wrapped to slice the
// log at each call. Wrapping, not re-implementing: the double still owns the D1 surface.
type Captured = Pick<FakeD1Call, 'sql' | 'binds'>;

function captureDb(): { db: D1Database; batches: Captured[][] } {
  const fake = recordingD1();
  const batches: Captured[][] = [];
  // Batch groups come from the PREPARE log, not the batch log: batch() re-records each statement
  // under via:'batch' without its binds (prepare() already logged those), and the binds are half of
  // what these tests assert. Prepared statements are consumed by successive batches in order.
  const inner = fake.db.batch.bind(fake.db);
  let consumed = 0;
  fake.db.batch = (async (statements: D1PreparedStatement[]) => {
    const results = await inner(statements);
    const prepared = fake.calls.filter((c) => c.via === 'prepare');
    batches.push(
      prepared
        .slice(consumed, consumed + statements.length)
        .map(({ sql, binds }) => ({ sql, binds })),
    );
    consumed += statements.length;
    return results;
  }) as typeof fake.db.batch;
  return { db: fake.db, batches };
}

const row = (cols: readonly string[], overrides: Record<string, unknown> = {}) =>
  Object.fromEntries(cols.map((c) => [c, overrides[c] ?? `${c}-val`]));

describe('upsertContractStaging', () => {
  it('deletes the source scope then inserts, all in one batch, returning the row count', async () => {
    const { db, batches } = captureDb();
    const rows = [row(CONTRACT_STAGING_COLS), row(CONTRACT_STAGING_COLS)] as never;
    const n = await upsertContractStaging(db, 'aop', rows);

    expect(n).toBe(2);
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    // DELETE is first and scoped to the source tag.
    expect(batch[0]!.sql).toBe('DELETE FROM raw_contracts WHERE source = ?');
    expect(batch[0]!.binds).toEqual(['aop']);
    // then one INSERT per row, with exactly one bound value per column.
    expect(batch).toHaveLength(3);
    expect(batch[1]!.sql).toContain('INSERT INTO raw_contracts');
    expect(batch[1]!.sql).toContain(CONTRACT_STAGING_COLS.join(', '));
    expect(batch[1]!.binds).toHaveLength(CONTRACT_STAGING_COLS.length);
  });

  it('coalesces a missing column to null rather than binding undefined', async () => {
    const { db, batches } = captureDb();
    const partial = row(CONTRACT_STAGING_COLS);
    delete partial[CONTRACT_STAGING_COLS[1]!]; // absent key
    delete partial[CONTRACT_STAGING_COLS[2]!]; // absent key
    await upsertContractStaging(db, 'aop', [partial] as never);

    const insert = batches[0]![1]!;
    expect(insert.binds[0]).toBe(`${CONTRACT_STAGING_COLS[0]}-val`); // present column keeps its value
    expect(insert.binds[1]).toBeNull(); // absent key → null, never undefined
    expect(insert.binds[2]).toBeNull();
    expect(insert.binds.every((a) => a !== undefined)).toBe(true);
  });

  it('issues a lone scoped DELETE and inserts nothing for an empty set', async () => {
    const { db, batches } = captureDb();
    const n = await upsertContractStaging(db, 'aop', []);

    expect(n).toBe(0);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0]![0]!.sql).toBe('DELETE FROM raw_contracts WHERE source = ?');
  });
});

describe('chunking at CHUNK=100', () => {
  const make = (n: number) => Array.from({ length: n }, () => row(CONTRACT_STAGING_COLS)) as never;

  it('keeps a full 100-row set (plus the DELETE) in a single batch', async () => {
    const { db, batches } = captureDb();
    const n = await upsertContractStaging(db, 's', make(100));
    expect(n).toBe(100);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(101); // DELETE + 100 inserts
  });

  it('splits 101 rows into [DELETE+100] then [1], DELETE only in the first batch', async () => {
    const { db, batches } = captureDb();
    const n = await upsertContractStaging(db, 's', make(101));
    expect(n).toBe(101);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(101);
    expect(batches[1]).toHaveLength(1);
    // the DELETE must not repeat in later batches (would wipe the first chunk's inserts)
    expect(batches[1]![0]!.sql).toContain('INSERT INTO');
    expect(
      batches
        .slice(1)
        .flat()
        .some((s) => s.sql.startsWith('DELETE')),
    ).toBe(false);
  });

  it('splits 250 rows into three batches (101, 100, 50)', async () => {
    const { db, batches } = captureDb();
    const n = await upsertContractStaging(db, 's', make(250));
    expect(n).toBe(250);
    expect(batches.map((b) => b.length)).toEqual([101, 100, 50]);
  });
});

describe('table + column routing per staging target', () => {
  const cases: Array<{
    name: string;
    fn: (db: D1Database, source: string, rows: never) => Promise<number>;
    table: string;
    cols: readonly string[];
  }> = [
    {
      name: 'amendment',
      fn: upsertAmendmentStaging,
      table: 'raw_amendments',
      cols: AMENDMENT_STAGING_COLS,
    },
    { name: 'party', fn: upsertPartyStaging, table: 'raw_ocds_parties', cols: PARTY_STAGING_COLS },
    { name: 'lot', fn: upsertLotStaging, table: 'raw_ocds_lots', cols: LOT_STAGING_COLS },
    {
      name: 'base-contract',
      fn: upsertBaseContractStaging,
      table: 'raw_contracts',
      cols: BASE_CONTRACT_COLS,
    },
    {
      name: 'base-tender',
      fn: upsertBaseTenderStaging,
      table: 'raw_tenders',
      cols: BASE_TENDER_COLS,
    },
    {
      name: 'base-amendment',
      fn: upsertBaseAmendmentStaging,
      table: 'raw_amendments',
      cols: BASE_AMENDMENT_COLS,
    },
  ];

  for (const { name, fn, table, cols } of cases) {
    it(`${name} → ${table} with its own column set`, async () => {
      const { db, batches } = captureDb();
      const n = await fn(db, 'src', [row(cols)] as never);
      expect(n).toBe(1);
      expect(batches[0]![0]!.sql).toBe(`DELETE FROM ${table} WHERE source = ?`);
      expect(batches[0]![1]!.sql).toContain(`INSERT INTO ${table} (${cols.join(', ')})`);
      expect(batches[0]![1]!.binds).toHaveLength(cols.length);
    });
  }
});
