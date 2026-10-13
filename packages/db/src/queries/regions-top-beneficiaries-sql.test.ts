/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { getRegionTopBeneficiaries } from './regions';

// Row-narrowing integration test for the region-total denominator (review thread on #141): the
// unit tests in regions.test.ts run against a fake D1 that hands back pre-shaped rows, so they
// can't catch a wrong SQL JOIN producing the wrong `region_total` — only a real SQL engine can.
// This seeds a contract whose bidder_id has no matching `bidders` row (the INNER JOIN to
// `bidders` drops it from the per-bidder breakdown, same as a NULL/unattributed bidder would),
// and asserts the top beneficiary's `share` is still measured against the region's FULL value —
// not just the value attributed to bidders that matched.

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

// Пловдив (BG421): one contract to a known bidder (600 EUR) + one contract to a bidder_id with
// NO row in `bidders` (400 EUR) — simulating an unattributed/NULL-like bidder. Region total is
// 1000 EUR; only the 600 EUR contract is joinable and shows up as a beneficiary row.
const FIXTURE = `
INSERT INTO authorities (id, name, bulstat, type_group, region) VALUES
  ('auth:1', 'Институция А', '100000001', 'община', 'Пловдив');
INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
  ('eik:known', 'Известна Фирма ООД', '200000002', '200000002', 1, 'company');
INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type, status) VALUES
  ('t:A', 'UNP-A', 'Поръчка А', 'auth:1', '45000000', 'открита процедура', 'awarded'),
  ('t:B', 'UNP-B', 'Поръчка Б', 'auth:1', '45000000', 'открита процедура', 'awarded');
INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, value_flag, amount_eur) VALUES
  ('c:known',   't:A', 'eik:known',    600, 'EUR', '2024-01-01', 'ok', 600),
  ('c:unmatched', 't:B', 'eik:unmatched', 400, 'EUR', '2024-01-02', 'ok', 400);
`;

let open: DatabaseSync | null = null;

function realDb(): D1Database {
  const db = new DatabaseSync(':memory:');
  for (const m of migrations) db.exec(readFileSync(resolve(migrationsDir, m), 'utf8'));
  // node:sqlite enforces FKs by default; D1 does not unless a migration opts in. This lets the
  // fixture insert the dangling `bidder_id` a real (unenforced-FK) D1 table can hold, matching
  // the production shape the reviewed query has to tolerate.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(FIXTURE);
  open = db;
  return d1FromSqlite(db);
}

afterEach(() => {
  open?.close();
  open = null;
});

describe('getRegionTopBeneficiaries region_total denominator (real SQLite, #141)', () => {
  it('measures share against the region TOTAL, not just the value attributed to joinable bidders', async () => {
    const map = await getRegionTopBeneficiaries(realDb(), {});
    const plovdiv = map.get('BG421') ?? [];

    // The unmatched-bidder contract is invisible as a beneficiary row (can't attribute it to a
    // company), but it must still count toward the denominator.
    expect(plovdiv).toHaveLength(1);
    expect(plovdiv[0]).toMatchObject({ name: 'Известна Фирма ООД', valueEur: 600 });
    expect(plovdiv[0]?.share).toBeCloseTo(600 / 1000);
  });
});
