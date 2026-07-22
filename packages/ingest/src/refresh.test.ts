// Drift alarm for REFRESH_SLICE_ROLLUP_GROUPS (#158): scripts/import.mjs splits the slice derive
// on this list to gate FX between "rows derived" and "rollups written", and backfill-fx.mjs
// re-runs exactly these groups over a touched set. A renamed or re-ordered @refresh-batch in
// refresh-slice.sql must fail HERE, not silently skip a rollup.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REFRESH_SLICE_ROLLUP_GROUPS, refreshSliceStatementGroups } from './refresh';

const refreshSliceSql = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/refresh-slice.sql'),
  'utf8',
);

describe('REFRESH_SLICE_ROLLUP_GROUPS', () => {
  it('is the contiguous tail of refresh-slice.sql, in file order', () => {
    const names = refreshSliceStatementGroups(refreshSliceSql).map((g) => g.name);
    expect(names.slice(-REFRESH_SLICE_ROLLUP_GROUPS.length)).toEqual([
      ...REFRESH_SLICE_ROLLUP_GROUPS,
    ]);
    // …and none of them leaks into the derive half of the split.
    for (const name of names.slice(0, -REFRESH_SLICE_ROLLUP_GROUPS.length)) {
      expect(REFRESH_SLICE_ROLLUP_GROUPS).not.toContain(name);
    }
  });
});
