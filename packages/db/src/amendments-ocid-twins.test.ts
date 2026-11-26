// The served OCID annex twins have ONE definition: AMENDMENT_OCID_TWINS_SQL in scripts/integrity-checks.mjs.
// So do the served twins keyed by an EOP annex's annex-side number: AMENDMENT_RAW_NUMBER_TWINS_SQL.
// The `amendment-twin-dedup` gate counts it, and scripts/refresh-slice.sql (`@refresh-batch amendments`)
// deletes it. The refresh runs as a .sql file in the Worker and the CLI alike, so it cannot import the
// constant; the block between its markers is held byte-identical here instead — the repo's drift-guard
// form (see amendments-bridge-lockstep.test.ts). Without it, the gate and the removal could drift apart:
// a red gate the pipeline never clears, or a removal of rows the gate does not call twins.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AMENDMENT_OCID_TWINS_SQL,
  AMENDMENT_RAW_NUMBER_TWINS_SQL,
} from '../../../scripts/integrity-checks.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const START = '-- @ocid-twin-lockstep start';
const END = '-- @ocid-twin-lockstep end';

describe('served OCID annex twins: one definition', () => {
  it('the removal in refresh-slice.sql deletes exactly the rows the gate counts', () => {
    const sql = readFileSync(resolve(root, 'scripts/refresh-slice.sql'), 'utf8');
    const start = sql.indexOf(START);
    const end = sql.indexOf(END, start);
    expect(start, `no "${START}" marker in refresh-slice.sql`).toBeGreaterThanOrEqual(0);
    expect(end, `no "${END}" marker in refresh-slice.sql`).toBeGreaterThan(start);
    // The block is the subquery of the DELETE, in the batch that promotes the window's amendments.
    const before = sql.slice(0, start);
    expect(before.trimEnd().endsWith('DELETE FROM amendments\nWHERE id IN (')).toBe(true);
    expect(before.lastIndexOf('-- @refresh-batch amendments')).toBeGreaterThan(
      before.lastIndexOf('-- @refresh-batch contracts'),
    );
    expect(sql.slice(start + START.length, end).trim()).toBe(AMENDMENT_OCID_TWINS_SQL);
  });

  it('names only OCDS rows keyed by an OCID', () => {
    expect(AMENDMENT_OCID_TWINS_SQL).toContain(
      "WHERE unp GLOB 'ocds-??????-?*' AND source LIKE 'ocds:%'",
    );
    expect(AMENDMENT_OCID_TWINS_SQL.trim().startsWith('WITH ocid_rows')).toBe(true);
  });
});

const RAW_START = '-- @raw-number-twin-lockstep start';
const RAW_END = '-- @raw-number-twin-lockstep end';

describe('served annex-side number twins: one definition', () => {
  it('the removal in refresh-slice.sql deletes exactly the rows the gate counts', () => {
    const sql = readFileSync(resolve(root, 'scripts/refresh-slice.sql'), 'utf8');
    const start = sql.indexOf(RAW_START);
    const end = sql.indexOf(RAW_END, start);
    expect(start, `no "${RAW_START}" marker in refresh-slice.sql`).toBeGreaterThanOrEqual(0);
    expect(end, `no "${RAW_END}" marker in refresh-slice.sql`).toBeGreaterThan(start);
    expect(sql.indexOf(RAW_START, end)).toBe(-1);
    // The block is the subquery of the DELETE, in the batch that promotes the window's amendments, after
    // the promotion itself.
    const before = sql.slice(0, start);
    expect(before.trimEnd().endsWith('DELETE FROM amendments\nWHERE id IN (')).toBe(true);
    expect(before.lastIndexOf('-- @refresh-batch amendments')).toBeGreaterThan(
      before.lastIndexOf('-- @refresh-batch contracts'),
    );
    expect(before.lastIndexOf('INSERT OR REPLACE INTO amendments')).toBeGreaterThan(
      before.lastIndexOf('-- @refresh-batch amendments'),
    );
    expect(sql.slice(start + RAW_START.length, end).trim()).toBe(AMENDMENT_RAW_NUMBER_TWINS_SQL);
  });

  it('names only OCDS rows, never one whose number names a contract', () => {
    expect(AMENDMENT_RAW_NUMBER_TWINS_SQL).toContain("WHERE o.source LIKE 'ocds:%'");
    expect(AMENDMENT_RAW_NUMBER_TWINS_SQL).toContain(
      "WHERE c.tender_id = 't:' || o.unp AND c.contract_number = o.contract_number",
    );
    expect(AMENDMENT_RAW_NUMBER_TWINS_SQL.trim().startsWith('SELECT o.id')).toBe(true);
  });
});
