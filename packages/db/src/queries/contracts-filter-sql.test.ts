/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { listContracts, streamContractsCsv } from './contracts';

// Row-narrowing integration test for the contract list filters (issue #138). The unit tests in
// contracts.test.ts run against a fake D1 that ignores WHERE clauses, so they prove the plumbing
// (URL → params → classifier) but not that a filter actually narrows rows — deleting the
// `if (p.bids === 'one')` branch in buildFilters left the whole suite green while #138 silently
// reopened. This runs listContracts/streamContractsCsv against a REAL SQLite built from the
// production migration (node:sqlite, no external dependency), seeded with bids_received ∈
// {NULL, 0, 1, 2}, and asserts `bids: 'one'` returns exactly the single-bid row.

// Apply the WHOLE migration chain (like src/migrations.test.ts), so a future 000N migration
// that adds a column read by the export SELECT can't fail this test confusingly.
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

// One contract per bids_received bucket: NULL (not reported), 0, 1 (the single-offer row), 2.
const FIXTURE = `
INSERT INTO authorities (id, name, bulstat, type_group) VALUES
  ('auth:100000001', 'Институция А', '100000001', 'община');
INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
  ('eik:200000001', 'Фирма Х', '200000001', '200000001', 1, 'company');
INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type, status) VALUES
  ('t:A', 'UNP-A', 'Поръчка А', 'auth:100000001', '45000000', 'открита процедура', 'awarded');
INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, bids_received, value_flag, amount_eur) VALUES
  ('c:NULL', 't:A', 'eik:200000001', 100, 'EUR', '2024-01-01', NULL, 'ok', 100),
  ('c:ZERO', 't:A', 'eik:200000001', 200, 'EUR', '2024-01-02', 0,    'ok', 200),
  ('c:ONE',  't:A', 'eik:200000001', 300, 'EUR', '2024-01-03', 1,    'ok', 300),
  ('c:TWO',  't:A', 'eik:200000001', 400, 'EUR', '2024-01-04', 2,    'ok', 400);
`;

/** Minimal D1Database facade over node:sqlite — enough for the query layer's prepare/bind/all/first. */
function d1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let bound: (string | number | null)[] = [];
      const stmt = {
        bind(...params: (string | number | null)[]) {
          bound = params;
          return stmt;
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...bound) as T[] };
        },
        async first<T>() {
          return (db.prepare(sql).get(...bound) ?? null) as T | null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

let open: DatabaseSync | null = null;

function realDb(): D1Database {
  const db = new DatabaseSync(':memory:');
  for (const m of migrations) db.exec(readFileSync(resolve(migrationsDir, m), 'utf8'));
  db.exec(FIXTURE);
  open = db;
  return d1(db);
}

afterEach(() => {
  open?.close();
  open = null;
});

async function csvDataRows(res: Response): Promise<string[]> {
  const text = await res.text();
  return text.trim().split('\n').slice(1); // drop the BOM+header line
}

describe('contract filters against a real SQLite engine (#138)', () => {
  it('bids=one narrows the list to exactly the single-bid row', async () => {
    const db = realDb();

    const all = await listContracts(db, { pageSize: 10 });
    expect(all.total).toBe(4); // the seed really covers NULL/0/1/2

    const single = await listContracts(db, { bids: 'one', pageSize: 10 });
    expect(single.total).toBe(1);
    expect(single.items).toHaveLength(1);
    expect(single.items[0]!.bidsReceived).toBe(1);
    expect(single.items[0]!.valueEur).toBe(300);
  });

  it('bids=one narrows the CSV export to exactly the single-bid row', async () => {
    const db = realDb();

    const allRows = await csvDataRows(streamContractsCsv(db, {}));
    expect(allRows).toHaveLength(4);

    const singleRows = await csvDataRows(streamContractsCsv(db, { bids: 'one' }));
    expect(singleRows).toHaveLength(1);
    const cells = singleRows[0]!.split(',');
    expect(cells[cells.length - 1]).toBe('1'); // bids_received column of the single-bid row
    expect(cells).toContain('300'); // the € 300 single-bid contract, not any other row
  });

  it('bids=one composes with other filters instead of replacing them', async () => {
    const db = realDb();

    // year 2024 matches all four rows; adding bids=one must still narrow to the single-bid row.
    const page = await listContracts(db, { years: ['2024'], bids: 'one', pageSize: 10 });
    expect(page.total).toBe(1);
    expect(page.items[0]!.bidsReceived).toBe(1);
  });
});
