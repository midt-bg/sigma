/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { listAuthorities } from './authorities';
import { listCompanies } from './companies';
import { contractsSummary, listSingleOfferContracts } from './contracts';
import { getHomeData } from './home';

// End-to-end value-base guard: build the production rollups, then exercise the live aggregation
// paths used by page filters against the same rows. Every non-NULL value_flag variant is represented,
// including a repaired value_suspect; the final NULL value_suspect must be absent from every sum.
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../migrations');
const migrations = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(resolve(migrationsDir, file), 'utf8'));
const precompute = readFileSync(resolve(here, '../../../../scripts/precompute.sql'), 'utf8');

const FIXTURE = `
INSERT INTO authorities (id, name, bulstat, type_group) VALUES
  ('auth:100000001', 'Институция А', '100000001', 'община'),
  ('auth:100000002', 'Институция Б', '100000002', 'агенция');
INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
  ('eik:200000001', 'Фирма Х', '200000001', '200000001', 1, 'company'),
  ('eik:200000002', 'Фирма Y', '200000002', '200000002', 1, 'company');
INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type, status) VALUES
  ('t:A45', 'UNP-A45', 'Поръчка А 45', 'auth:100000001', '45000000', 'открита процедура', 'awarded'),
  ('t:A72', 'UNP-A72', 'Поръчка А 72', 'auth:100000001', '72000000', 'открита процедура', 'awarded'),
  ('t:B45', 'UNP-B45', 'Поръчка Б 45', 'auth:100000002', '45000000', 'открита процедура', 'awarded'),
  ('t:B72', 'UNP-B72', 'Поръчка Б 72', 'auth:100000002', '72000000', 'открита процедура', 'awarded');
INSERT INTO contracts
  (id, tender_id, bidder_id, amount, currency, signed_at, bids_received, value_flag, amount_eur)
VALUES
  ('c:ok',             't:A45', 'eik:200000001', 100,    'EUR', '2024-01-01', 1, 'ok',              100),
  ('c:review',         't:A45', 'eik:200000001', 200,    'EUR', '2024-01-02', 1, 'review',          200),
  ('c:annex',          't:A72', 'eik:200000002', 300,    'EUR', '2024-01-03', 1, 'annex_suspect',  300),
  ('c:low',            't:B45', 'eik:200000001', -40,    'EUR', '2024-01-04', 1, 'value_low',       -40),
  ('c:suspect-repair', 't:B72', 'eik:200000002', 500,    'EUR', '2024-01-05', 1, 'value_suspect',   500),
  ('c:suspect-null',   't:B72', 'eik:200000002', 999999, 'EUR', '2024-01-06', 1, 'value_suspect',  NULL);
`;

/** Minimal D1 facade over node:sqlite; no sqlite3 or wrangler subprocess is involved. */
function d1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let bound: (string | number | null)[] = [];
      const statement = {
        bind(...params: (string | number | null)[]) {
          bound = params;
          return statement;
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...bound) as T[] };
        },
        async first<T>() {
          return (db.prepare(sql).get(...bound) ?? null) as T | null;
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

let open: DatabaseSync | null = null;

function realDb(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of migrations) sqlite.exec(migration);
  sqlite.exec(FIXTURE);
  sqlite.exec(precompute);
  open = sqlite;
  return { sqlite, db: d1(sqlite) };
}

afterEach(() => {
  open?.close();
  open = null;
});

describe('canonical contract value base', () => {
  it('keeps filtered authority, company, and sector page totals identical to their rollups', async () => {
    const { sqlite, db } = realDb();

    // All fixture rows are in 2024, so this forces each leaderboard through its live contracts
    // aggregation without changing the represented corpus.
    const [authorityPage, companyPage] = await Promise.all([
      listAuthorities(db, { years: ['2024'], pageSize: 10 }),
      listCompanies(db, { years: ['2024'], pageSize: 10 }),
    ]);
    const authorityRollups = sqlite
      .prepare('SELECT authority_id, spent_eur FROM authority_totals ORDER BY authority_id')
      .all() as { authority_id: string; spent_eur: number }[];
    const companyRollups = sqlite
      .prepare('SELECT bidder_id, won_eur FROM company_totals ORDER BY bidder_id')
      .all() as { bidder_id: string; won_eur: number }[];
    const sectorRollups = sqlite
      .prepare('SELECT division, value_eur FROM sector_totals ORDER BY division')
      .all() as { division: string; value_eur: number }[];

    const authorityPageTotals = new Map(
      authorityPage.items.map((item) => [`auth:${item.slug}`, item.spentEur]),
    );
    const companyPageTotals = new Map(
      companyPage.items.map((item) => [`eik:${item.slug}`, item.wonEur]),
    );

    for (const rollup of authorityRollups) {
      expect(authorityPageTotals.get(rollup.authority_id)).toBe(rollup.spent_eur);
    }
    for (const rollup of companyRollups) {
      expect(companyPageTotals.get(rollup.bidder_id)).toBe(rollup.won_eur);
    }
    for (const rollup of sectorRollups) {
      const pageTotal = await contractsSummary(db, { sectors: [rollup.division] });
      expect(pageTotal.valueEur).toBe(rollup.value_eur);
    }
  });

  it('uses the same non-NULL base for both homepage single-offer queries', async () => {
    const { db } = realDb();

    const [home, contracts] = await Promise.all([
      getHomeData(db),
      listSingleOfferContracts(db, 'value', 10),
    ]);

    expect(home.totals.valueEur).toBe(1060);
    expect(home.singleOffer).toEqual({ valueEur: 1060, contracts: 5 });
    expect(contracts.map((contract) => contract.valueEur)).toEqual([500, 300, 200, 100, -40]);
  });
});
