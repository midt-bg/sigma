/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { listAuthorities } from './authorities';
import { listCompanies } from './companies';
import { competitionTotals } from './competition';
import { contractsSummary, listSingleOfferContracts } from './contracts';
import { getCompany } from './details';
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

let open: DatabaseSync | null = null;

function realDb(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of migrations) sqlite.exec(migration);
  sqlite.exec(FIXTURE);
  sqlite.exec(precompute);
  open = sqlite;
  return { sqlite, db: d1FromSqlite(sqlite) };
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

  it('gives the home page the national single-offer share /competition gives, on its base', async () => {
    const { db } = realDb();

    const [home, national, contracts] = await Promise.all([
      getHomeData(db),
      competitionTotals(db, {}),
      listSingleOfferContracts(db, 'value', 10),
    ]);

    expect(home.totals.valueEur).toBe(1060);
    // Contracts with a known number of offers — all six here, the one without a usable value too —
    // valued on positive amounts, so the negative value_low row cannot push the share outside [0, 1].
    expect(home.singleOffer).toEqual({
      valueEur: 1100,
      contracts: 6,
      baseValueEur: 1100,
      baseContracts: 6,
    });
    expect(national).toMatchObject({
      contracts: home.singleOffer.baseContracts,
      singleOffer: home.singleOffer.contracts,
      valueEur: home.singleOffer.baseValueEur,
      singleOfferValueEur: home.singleOffer.valueEur,
    });
    // The list beside the share shows every priced single-offer contract as it is.
    expect(contracts.map((contract) => contract.valueEur)).toEqual([500, 300, 200, 100, -40]);
  });
});

describe('a company whose negative rows outweigh the rest', () => {
  it('shows no negative or inflated procedure share', async () => {
    const { sqlite, db } = realDb();
    sqlite.exec(`
      INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
        ('eik:200000003', 'Фирма Z', '200000003', '200000003', 1, 'company');
      INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type, status) VALUES
        ('t:Z-open', 'UNP-Z-OPEN', 'Открита Z', 'auth:100000001', '45000000', 'Открита процедура', 'awarded'),
        ('t:Z-direct', 'UNP-Z-DIRECT', 'Пряка Z', 'auth:100000001', '45000000', 'Пряко договаряне', 'awarded');
      INSERT INTO contracts
        (id, tender_id, bidder_id, amount, currency, signed_at, bids_received, value_flag, amount_eur)
      VALUES
        ('c:z-open', 't:Z-open',   'eik:200000003',  100, 'EUR', '2024-02-01', 2, 'ok',        100),
        ('c:z-low',  't:Z-direct', 'eik:200000003', -300, 'EUR', '2024-02-02', 1, 'value_low', -300);
    `);
    sqlite.exec(precompute);

    const company = (await getCompany(db, 'eik:200000003'))!;
    expect(company.wonEur).toBe(-200);
    // The net-negative group is dropped; the positive one is kept at a zero share of a non-positive
    // total — never -50%, and never a share above the whole.
    expect(company.procedureMix).toEqual([
      expect.objectContaining({ key: 'open', contracts: 1, valueEur: 100, sharePct: 0 }),
    ]);
  });
});

describe('the home companies figure', () => {
  it('counts the companies the list shows, not the bucket of winners with no identity', async () => {
    const { sqlite, db } = realDb();
    sqlite.exec(`
      INSERT INTO bidders (id, name, kind) VALUES ('unknown:1', 'Неустановен изпълнител', 'unknown');
      INSERT INTO contracts
        (id, tender_id, bidder_id, amount, currency, signed_at, bids_received, value_flag, amount_eur)
      VALUES ('c:unknown', 't:A45', 'unknown:1', 10, 'EUR', '2024-03-01', 2, 'ok', 10);
    `);
    sqlite.exec(precompute);

    const [home, list] = await Promise.all([getHomeData(db), listCompanies(db, {})]);
    expect(home.totals.bidders).toBe(2);
    expect(home.totals.bidders).toBe(list.total);
  });
});
