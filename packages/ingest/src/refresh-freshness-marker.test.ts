/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { refreshSliceStatementGroups } from './refresh';

// The slice refresh runs its groups as SEPARATE batches — `runRefreshSliceBatches` in scripts/import.mjs
// shells out once per group, and the Worker path calls db.batch() once per group. Nothing is
// transactional ACROSS groups, so a group that throws leaves every earlier group applied and every later
// one unrun. That is not hypothetical: a catch-up on 2026-08-23 died in `amendments` with SQLITE_NOMEM,
// leaving contracts and tenders advanced by four days while `data_freshness` and `home_totals` still
// advertised the previous slice. A reader was told a date that was confidently wrong rather than unknown.
//
// The fix is ordering, not atomicity: nulling `as_of` in the FIRST group means an interrupted refresh
// reads as „unknown slice", and `@refresh-batch globals` writes the true values back at the end. These
// tests hold that ordering, because the property is invisible on a successful run — it only shows up on
// the failure nobody is watching.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const refreshSlice = readFileSync(resolve(root, 'scripts/refresh-slice.sql'), 'utf8');
const groups = refreshSliceStatementGroups(refreshSlice);

const indexOfGroupWhere = (pred: (sql: string) => boolean) =>
  groups.findIndex((g) => g.statements.some((s) => pred(s)));

describe('freshness markers survive an interrupted slice refresh', () => {
  it('nulls both markers in the very first group', () => {
    // First, not merely early: any group that runs before the invalidation can fail and strand a stale
    // marker, which is exactly the state this guards against.
    const first = groups[0]!;
    const sql = first.statements.join('\n');
    expect(first.name).toBe('setup');
    expect(sql).toMatch(/UPDATE\s+data_freshness\s+SET\s+as_of\s*=\s*NULL/i);
    expect(sql).toMatch(/UPDATE\s+home_totals\s+SET\s+as_of\s*=\s*NULL/i);
  });

  it('writes the true values only in a LATER group', () => {
    // If the write ever moves into (or before) the invalidating group, the invalidation stops meaning
    // anything — the marker would be restored before the work it describes has happened.
    const invalidates = indexOfGroupWhere((s) =>
      /UPDATE\s+data_freshness\s+SET\s+as_of\s*=\s*NULL/i.test(s),
    );
    const writes = indexOfGroupWhere((s) => /INSERT\s+INTO\s+data_freshness/i.test(s));
    expect(invalidates).toBe(0);
    expect(writes).toBeGreaterThan(invalidates);
  });

  it('keeps both markers written in the same group, so they cannot disagree', () => {
    // data_freshness feeds the ETL catch-up planner; home_totals feeds the public „as of" date and the
    // CSV export. Splitting them across groups would let a failure land between the two and leave the
    // site and the planner describing different slices.
    const freshness = indexOfGroupWhere((s) => /INSERT\s+INTO\s+data_freshness/i.test(s));
    const totals = indexOfGroupWhere((s) => /INSERT\s+INTO\s+home_totals/i.test(s));
    expect(freshness).toBe(totals);
  });

  it('leaves refreshed_at alone, which is NOT NULL in the schema', () => {
    // Nulling refreshed_at instead would throw on the UPDATE and turn a resilience fix into an outage.
    const first = groups[0]!.statements.join('\n');
    expect(first).not.toMatch(/SET[^;]*refreshed_at\s*=\s*NULL/i);
  });
});
