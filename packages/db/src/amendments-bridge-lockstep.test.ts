// Issue #286 — the tender.id → УНП bridge UPDATE is duplicated in the full path (derive-amendments.sql)
// and the incremental path (refresh-slice.sql). Both must recover the SAME УНП, or a daily slice refresh
// on the production Worker would silently regress to the #286 bug while every functional test stayed green
// (the Worker runs refresh-slice.sql, not derive-amendments.sql). The prefer-EOP dedup DELETE deliberately
// diverges — the slice path additionally reconciles against the cumulative served `amendments` — so only
// the marked bridge block is held byte-identical here. This is the repo's established drift-guard form
// (see search-sql.test.ts / precompute-cohort.test.ts).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const START = '-- @bridge-lockstep start';
const END = '-- @bridge-lockstep end';

function bridgeBlock(file: string): string {
  const sql = readFileSync(resolve(root, file), 'utf8');
  const start = sql.indexOf(START);
  const end = sql.indexOf(END, start);
  expect(start, `no "${START}" marker in ${file}`).toBeGreaterThanOrEqual(0);
  expect(end, `no "${END}" marker in ${file}`).toBeGreaterThan(start);
  return sql.slice(start + START.length, end).trim();
}

describe('OCDS amendment bridge lockstep (issue #286)', () => {
  it('the bridge UPDATE is byte-identical between derive-amendments.sql and refresh-slice.sql', () => {
    const derive = bridgeBlock('scripts/derive-amendments.sql');
    const slice = bridgeBlock('scripts/refresh-slice.sql');

    // Sanity: the extracted span really is the bridge UPDATE, not an empty/misplaced marker range.
    expect(derive).toContain('UPDATE raw_amendments');
    expect(derive).toContain('raw_amendments.tender_ext_id');
    expect(derive).toContain('ORDER BY rt.unp LIMIT 1');
    expect(derive).toContain('ORDER BY rc.unp LIMIT 1');

    // The guard: exact byte-equality. Deleting the block from refresh-slice.sql fails on the missing
    // marker above; changing the recovery in either file fails here.
    expect(slice).toBe(derive);
  });
});
