/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The date sort indexes only get used if their COALESCE sentinel is byte-identical to the ORDER BY
// expression the query layer emits (queries/contracts.ts SORTS). The EXPLAIN test proves the plan on a
// local sqlite3, whose planner is not bit-exact to D1 — so back it with a planner-INDEPENDENT static
// check that the sentinels themselves match. A .sql migration can't import a TS constant, so this
// compares the two source files directly; a drift fails here regardless of the DB engine (review ydimitrof).

// This file is packages/db/src/…, so one level up is the @sigma/db package root.
const dbRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationSql = readFileSync(resolve(dbRoot, 'migrations/0005_list_sort_indexes.sql'), 'utf8');
const contractsTs = readFileSync(resolve(dbRoot, 'src/queries/contracts.ts'), 'utf8');

// Collect the sentinel literal of every COALESCE(<opt c.>signed_at, '<sentinel>') in a source.
function signedSentinels(src: string): string[] {
  const out: string[] = [];
  const re = /COALESCE\((?:c\.)?signed_at,\s*'([^']*)'\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]!);
  return [...new Set(out)].sort();
}

describe('date-sort sentinel sync (migration ↔ query layer)', () => {
  it('the signed_at COALESCE sentinels are byte-identical in the migration and SORTS', () => {
    const fromMigration = signedSentinels(migrationSql);
    const fromQuery = signedSentinels(contractsTs);

    // Guard against a regex that silently matches nothing (which would make the test pass vacuously).
    expect(fromMigration).toEqual(['', '9999-99']);
    expect(fromQuery).toEqual(fromMigration);
  });
});
