/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { getFlaggedValue } from './flagged';
import { listContracts } from './contracts';

// Integration test against a REAL SQLite built from the production migrations (node:sqlite), so the
// flag predicates and aggregate are proven to narrow/sum actual rows — the fake-D1 unit tests ignore
// WHERE clauses. Fixture exercises: de-duplicated total, overlapping by-type, category sums-to-total,
// and the amount_eur NULL basis (value_suspect contributes to the count but €0).
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

// c1 no_competition (община, sector 45, 1000) · c2 eu_no_competition (министерство, 72, 2000)
// c3 high_markup (община, 45, 1500) · c4 anomalies via value_suspect (министерство, 72, amount NULL)
// c5 OVERLAP no_competition + high_markup (община, 45, 2000) · c6 clean, unflagged (5000)
const FIXTURE = `
INSERT INTO authorities (id, name, bulstat, type_group) VALUES
  ('auth:obshtina', 'Община', '100000001', 'община'),
  ('auth:min', 'Министерство', '100000002', 'министерство'),
  ('auth:none', 'Без тип', '100000003', NULL);
INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
  ('eik:200000001', 'Фирма', '200000001', '200000001', 1, 'company');
INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type, status) VALUES
  ('t:o45', 'UNP-1', 'Строеж', 'auth:obshtina', '45000000', 'открита процедура', 'awarded'),
  ('t:m72', 'UNP-2', 'ИТ', 'auth:min', '72000000', 'открита процедура', 'awarded'),
  ('t:nocpv', 'UNP-3', 'Без CPV', 'auth:none', NULL, 'открита процедура', 'awarded');
INSERT INTO contracts
  (id, tender_id, bidder_id, amount, currency, signed_at, bids_received, bids_rejected, eu_funded,
   value_flag, date_flag, signing_value_eur, current_value_eur, amount_eur) VALUES
  ('c1', 't:o45', 'eik:200000001', 1000, 'EUR', '2024-01-01', 1, 0, 0, 'ok', 'ok', 1000, 1000, 1000),
  ('c2', 't:m72', 'eik:200000001', 2000, 'EUR', '2024-01-02', 1, 0, 1, 'ok', 'ok', 2000, 2000, 2000),
  ('c3', 't:o45', 'eik:200000001', 1500, 'EUR', '2024-01-03', 3, 0, 0, 'ok', 'ok', 1000, 1500, 1500),
  ('c4', 't:m72', 'eik:200000001', 9000, 'EUR', '2024-01-04', 3, 0, 0, 'value_suspect', 'ok', NULL, NULL, NULL),
  ('c5', 't:o45', 'eik:200000001', 2000, 'EUR', '2024-01-05', 1, 0, 0, 'ok', 'ok', 1000, 2000, 2000),
  ('c6', 't:m72', 'eik:200000001', 5000, 'EUR', '2024-01-06', 3, 0, 0, 'ok', 'ok', 5000, 5000, 5000),
  -- c7: flagged (no_competition) but on a tender with NULL cpv + authority with NULL type_group,
  -- so it lands in the total/count but in NEITHER the bySector nor byAuthorityType breakdown.
  ('c7', 't:nocpv', 'eik:200000001', 500, 'EUR', '2024-01-07', 1, 0, 0, 'ok', 'ok', 500, 500, 500);
`;

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

const byType = (f: Awaited<ReturnType<typeof getFlaggedValue>>, t: string) =>
  f.byType.find((r) => r.type === t)!;

describe('getFlaggedValue', () => {
  it('de-duplicates the total (a contract with two signals counts once)', async () => {
    const f = await getFlaggedValue(realDb());
    // c1..c5 + c7 flagged (c6 clean). c4 is value_suspect → NULL amount_eur → counted, €0.
    expect(f.contracts).toBe(6);
    expect(f.totalEur).toBe(7000); // 1000 + 2000 + 1500 + 0 + 2000 + 500
  });

  it('reports overlapping by-type slices (their sum exceeds the de-duplicated total)', async () => {
    const f = await getFlaggedValue(realDb());
    expect(byType(f, 'no_competition')).toMatchObject({ eur: 3500, contracts: 3 }); // c1 + c5 + c7
    expect(byType(f, 'eu_no_competition')).toMatchObject({ eur: 2000, contracts: 1 }); // c2
    expect(byType(f, 'high_markup')).toMatchObject({ eur: 3500, contracts: 2 }); // c3 + c5
    expect(byType(f, 'anomalies')).toMatchObject({ eur: 0, contracts: 1 }); // c4 (NULL amount)
    const sum = f.byType.reduce((n, r) => n + r.eur, 0);
    expect(sum).toBe(9000);
    expect(sum).toBeGreaterThan(f.totalEur); // c5 double-counted across two types
  });

  it('breaks down by sector as top slices that need NOT sum to the total', async () => {
    const f = await getFlaggedValue(realDb());
    const s45 = f.bySector.find((s) => s.code === '45')!;
    const s72 = f.bySector.find((s) => s.code === '72')!;
    expect(s45).toMatchObject({ eur: 4500, contracts: 3 }); // c1 + c3 + c5
    expect(s72).toMatchObject({ eur: 2000, contracts: 2 }); // c2 + c4
    // c7 has a NULL cpv_code → excluded from every sector slice, so the slices sum to LESS than total.
    expect(f.bySector.reduce((n, s) => n + s.eur, 0)).toBe(6500);
    expect(f.bySector.reduce((n, s) => n + s.eur, 0)).toBeLessThan(f.totalEur);
  });

  it('breaks down by authority type as slices that need NOT sum to the total', async () => {
    const f = await getFlaggedValue(realDb());
    const obshtina = f.byAuthorityType.find((a) => a.typeGroup === 'община')!;
    const min = f.byAuthorityType.find((a) => a.typeGroup === 'министерство')!;
    expect(obshtina).toMatchObject({ eur: 4500, contracts: 3 });
    expect(min).toMatchObject({ eur: 2000, contracts: 2 });
    // c7's authority has a NULL type_group → excluded, so the slices sum to LESS than total.
    expect(f.byAuthorityType.reduce((n, a) => n + a.eur, 0)).toBeLessThan(f.totalEur);
  });
});

describe('/contracts flag filter', () => {
  it('flag=no_competition narrows to the single-offer rows (incl. the overlapping one)', async () => {
    const r = await listContracts(realDb(), { flags: ['no_competition'], pageSize: 10 });
    expect(r.total).toBe(3); // c1, c5, c7
  });

  it('flag=high_markup narrows to the cost-growth rows', async () => {
    const r = await listContracts(realDb(), { flags: ['high_markup'], pageSize: 10 });
    expect(r.total).toBe(2); // c3, c5
  });

  it('flag=all matches every flagged contract', async () => {
    const r = await listContracts(realDb(), { flags: ['all'], pageSize: 10 });
    expect(r.total).toBe(6); // c1..c5, c7 — not the clean c6
  });

  it('multiple flag tokens are OR-combined (union)', async () => {
    const r = await listContracts(realDb(), {
      flags: ['no_competition', 'anomalies'],
      pageSize: 10,
    });
    expect(r.total).toBe(4); // c1, c5, c7 (no_competition) ∪ c4 (anomalies)
  });

  it('an unrecognised flag token matches nothing (not everything)', async () => {
    const r = await listContracts(realDb(), { flags: ['bogus'], pageSize: 10 });
    expect(r.total).toBe(0);
  });

  it('type= narrows to contracts of that authority type_group', async () => {
    const r = await listContracts(realDb(), { authorityTypes: ['министерство'], pageSize: 10 });
    expect(r.total).toBe(3); // c2, c4, c6 (all министерство tenders)
  });

  it('flag composes with sector/type instead of replacing them', async () => {
    const r = await listContracts(realDb(), {
      flags: ['all'],
      authorityTypes: ['министерство'],
      pageSize: 10,
    });
    expect(r.total).toBe(2); // министерство ∩ flagged = c2, c4
  });
});
