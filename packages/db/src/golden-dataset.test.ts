/// <reference types="node" />
// Golden regression dataset (#99) — a small synthetic corpus with HAND-VERIFIED expected
// numbers, traced end-to-end through the REAL production derive order (import.mjs runFullDerive):
// derive-amendments.sql → normalize-raw.sql → promote-amendments.sql → precompute.sql.
//
// Every value in GOLDEN below is derived BY HAND from the fixture inputs (the arithmetic is in
// the comments), never copied from pipeline output. If an assertion here goes red, either the
// change broke a published number (fix the code) or it intentionally moved the rules — in that
// case recompute the affected constants by hand from the fixture and the new rules, and say why
// in the PR. See docs/review-testing.md („Golden dataset") for the update procedure. There is
// deliberately NO regeneration script: blessing pipeline output would bless the bug this test
// exists to catch.
//
// This complements the reconciliation gate (scripts/integrity-checks.mjs): the gate proves the
// rollups agree with the contracts they summarise; this test proves both equal the ABSOLUTE
// numbers a human computed — so a misattribution that preserves grand totals still fails here.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertIntegrity } from '../../../scripts/integrity-checks.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const schemaPath = resolve(root, 'packages/db/migrations/0000_init.sql');
const workStagingSchemaPath = resolve(root, 'scripts/work-staging-schema.sql');
const deriveAmendmentsPath = resolve(root, 'scripts/derive-amendments.sql');
const loadNutsPath = resolve(root, 'scripts/load-nuts.sql');
const seedStateOwnedPath = resolve(root, 'scripts/seed-state-owned.sql');
const normalizePath = resolve(root, 'scripts/normalize-raw.sql');
const promoteAmendmentsPath = resolve(root, 'scripts/promote-amendments.sql');
const precomputePath = resolve(root, 'scripts/precompute.sql');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
}

function sqliteJson<T>(dbPath: string, sql: string): T[] {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
  return out ? (JSON.parse(out) as T[]) : [];
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', [dbPath], {
    input: `PRAGMA foreign_keys=ON;\n.read ${path}\n`,
    stdio: 'pipe',
  });
}

// ── The fixture ──────────────────────────────────────────────────────────────────────────────
// 2 authorities × 3 bidders × 8 contracts, sized so every total below is recomputable on paper.
//
//   Authorities
//     A1  eik 100000001  „Министерство на тестовата инфраструктура" → type_group 'министерство'
//         (OCDS party row: locality София, NUTS BG411 → region „София (столица)" via load-nuts.sql)
//     A2  eik 100000002  „Община Голдънво"                          → type_group 'община'
//   Bidders
//     B1  eik:111111111        „Голдън Строй ЕООД"   (valid ЕИК, private)
//     B2  eik:121396123        „Български пощи ЕАД"  (REAL state-owned EIK from seed-state-owned.sql)
//     B3  name:SECRET WINNER LTD (ЕИК „не се публикува" → name-keyed, eik_valid 0)
//
//   Contracts (CN-n on tender UNP-Gn; amount_eur per normalize-raw.sql; peg = 1.95583 BGN/EUR)
//     c1 A1→B1 BGN cpv45  signing 195583, est 200000 BGN            → ok            100000.00 (195583 ÷ 1.95583)
//     c2 A1→B2 EUR cpv45  signing 50000, est 60000 EUR, eu_funded   → ok             50000.00
//     c3 A2→B1 USD cpv33  signing 50000, est 60000 USD, fx 0.9      → ok             45000.00 (50000 × 0.9)
//     c4 A2→B3 EUR cpv33  signing 300000, est 1000 EUR              → value_suspect   1000.00 (300× est ⇒ repaired to est)
//     c5 A2→B1 EUR cpv33  signing 15000, est 1000 EUR               → review         15000.00 (15× est: ≥10×, <200×)
//     c6 A1→B2 BGN cpv45  signing 195.583, annex → current 19558.3  → annex_suspect    100.00 (100× signing ⇒ falls back to signing)
//     c7 A1→B1 BGN cpv45  signing 0                                 → value_low           0.00 (kept in sums, labelled)
//     c8 A2→B2 BGN cpv33  signing 39116.6, annex → current 58674.9  → ok             30000.00 (58674.9 ÷ 1.95583; 1.5× is a legit annex)
const FIXTURE = `
INSERT INTO fx_rates (base_currency, rate_date, eur_per_unit, source, fetched_at) VALUES
  ('USD', '2026-06-01', 0.9, 'test:fixed', '2026-06-09T00:00:00Z');

INSERT INTO raw_tenders
  (source, dataset_year, fetched_at, unp, tender_id, procedure_type, procurement_subject,
   cpv_code, cpv_description, contract_kind, estimated_value, currency, legal_basis,
   award_criteria, authority_name, authority_eik, authority_type, main_activity, deadline,
   notice_type, lot_id, lot_name, num_lots, eu_funded, published_at)
VALUES
  ('eop:tenders:2026-06-09', 2026, '2026-06-09T00:00:00Z', 'UNP-G1', 'TENDER-G1', 'open',
   'Golden tender 1', '45000000', 'Construction', 'works', 200000, 'BGN', 'basis', 'lowest',
   'Министерство на тестовата инфраструктура', '100000001', 'public', 'activity', '2026-05-30',
   'notice', NULL, NULL, 1, 0, '2026-05-20'),
  ('eop:tenders:2026-06-09', 2026, '2026-06-09T00:00:00Z', 'UNP-G2', 'TENDER-G2', 'open',
   'Golden tender 2', '45000000', 'Construction', 'works', 60000, 'EUR', 'basis', 'lowest',
   'Министерство на тестовата инфраструктура', '100000001', 'public', 'activity', '2026-05-30',
   'notice', NULL, NULL, 1, 1, '2026-05-20'),
  ('eop:tenders:2026-06-09', 2026, '2026-06-09T00:00:00Z', 'UNP-G3', 'TENDER-G3', 'open',
   'Golden tender 3', '33600000', 'Pharma', 'supplies', 60000, 'USD', 'basis', 'lowest',
   'Община Голдънво', '100000002', 'public', 'activity', '2026-05-30',
   'notice', NULL, NULL, 1, 0, '2026-05-20'),
  ('eop:tenders:2026-06-09', 2026, '2026-06-09T00:00:00Z', 'UNP-G4', 'TENDER-G4', 'open',
   'Golden tender 4', '33600000', 'Pharma', 'supplies', 1000, 'EUR', 'basis', 'lowest',
   'Община Голдънво', '100000002', 'public', 'activity', '2026-05-30',
   'notice', NULL, NULL, 1, 0, '2026-05-20'),
  ('eop:tenders:2026-06-09', 2026, '2026-06-09T00:00:00Z', 'UNP-G5', 'TENDER-G5', 'open',
   'Golden tender 5', '33600000', 'Pharma', 'supplies', 1000, 'EUR', 'basis', 'lowest',
   'Община Голдънво', '100000002', 'public', 'activity', '2026-05-30',
   'notice', NULL, NULL, 1, 0, '2026-05-20'),
  ('eop:tenders:2026-06-09', 2026, '2026-06-09T00:00:00Z', 'UNP-G6', 'TENDER-G6', 'open',
   'Golden tender 6', '45000000', 'Construction', 'works', NULL, 'BGN', 'basis', 'lowest',
   'Министерство на тестовата инфраструктура', '100000001', 'public', 'activity', '2026-05-30',
   'notice', NULL, NULL, 1, 0, '2026-05-20'),
  ('eop:tenders:2026-06-09', 2026, '2026-06-09T00:00:00Z', 'UNP-G7', 'TENDER-G7', 'open',
   'Golden tender 7', '45000000', 'Construction', 'works', NULL, 'BGN', 'basis', 'lowest',
   'Министерство на тестовата инфраструктура', '100000001', 'public', 'activity', '2026-05-30',
   'notice', NULL, NULL, 1, 0, '2026-05-20'),
  ('eop:tenders:2026-06-09', 2026, '2026-06-09T00:00:00Z', 'UNP-G8', 'TENDER-G8', 'open',
   'Golden tender 8', '33600000', 'Pharma', 'supplies', 100000, 'BGN', 'basis', 'lowest',
   'Община Голдънво', '100000002', 'public', 'activity', '2026-05-30',
   'notice', NULL, NULL, 1, 0, '2026-05-20');

INSERT INTO raw_contracts
  (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
   published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
   cpv_description, contract_kind, estimated_value, procurement_currency, legal_basis,
   award_criteria, authority_name, authority_eik, authority_type, main_activity, notice_type,
   lot_id, contract_number, contract_date, signing_value, currency, contract_subject,
   awarded_to_group, contractor_eik, contractor_name, contractor_country, winner_size,
   eu_funded, bids_received, bids_sme, bids_rejected, bids_non_eea, duration_days)
VALUES
  ('eop:contracts:2026-06-09', 2026, 'eop', '2026-06-09T00:00:00Z', 0, 'DOC-G1',
   '2026-06-01', 'UNP-G1', 'TENDER-G1', 'open', 'Golden tender 1', '45000000',
   'Construction', 'works', 200000, 'BGN', 'basis', 'lowest',
   'Министерство на тестовата инфраструктура', '100000001', 'public', 'activity', 'notice',
   NULL, 'CN-1', '2026-06-01', 195583, 'BGN', 'Golden contract 1',
   0, '111111111', 'Голдън Строй ЕООД', 'BG', 'small', 0, 3, 1, 0, 0, 30),
  ('eop:contracts:2026-06-09', 2026, 'eop', '2026-06-09T00:00:00Z', 0, 'DOC-G2',
   '2026-06-02', 'UNP-G2', 'TENDER-G2', 'open', 'Golden tender 2', '45000000',
   'Construction', 'works', 60000, 'EUR', 'basis', 'lowest',
   'Министерство на тестовата инфраструктура', '100000001', 'public', 'activity', 'notice',
   NULL, 'CN-2', '2026-06-02', 50000, 'EUR', 'Golden contract 2',
   0, '121396123', 'Български пощи ЕАД', 'BG', 'large', 1, 2, 0, 0, 0, 30),
  ('eop:contracts:2026-06-09', 2026, 'eop', '2026-06-09T00:00:00Z', 0, 'DOC-G3',
   '2026-06-03', 'UNP-G3', 'TENDER-G3', 'open', 'Golden tender 3', '33600000',
   'Pharma', 'supplies', 60000, 'USD', 'basis', 'lowest',
   'Община Голдънво', '100000002', 'public', 'activity', 'notice',
   NULL, 'CN-3', '2026-06-03', 50000, 'USD', 'Golden contract 3',
   0, '111111111', 'Голдън Строй ЕООД', 'BG', 'small', 0, 3, 1, 0, 0, 30),
  ('eop:contracts:2026-06-09', 2026, 'eop', '2026-06-09T00:00:00Z', 0, 'DOC-G4',
   '2026-06-04', 'UNP-G4', 'TENDER-G4', 'open', 'Golden tender 4', '33600000',
   'Pharma', 'supplies', 1000, 'EUR', 'basis', 'lowest',
   'Община Голдънво', '100000002', 'public', 'activity', 'notice',
   NULL, 'CN-4', '2026-06-04', 300000, 'EUR', 'Golden contract 4',
   0, 'не се публикува', 'SECRET WINNER LTD', 'BG', 'small', 0, 1, 0, 0, 0, 30),
  ('eop:contracts:2026-06-09', 2026, 'eop', '2026-06-09T00:00:00Z', 0, 'DOC-G5',
   '2026-06-05', 'UNP-G5', 'TENDER-G5', 'open', 'Golden tender 5', '33600000',
   'Pharma', 'supplies', 1000, 'EUR', 'basis', 'lowest',
   'Община Голдънво', '100000002', 'public', 'activity', 'notice',
   NULL, 'CN-5', '2026-06-05', 15000, 'EUR', 'Golden contract 5',
   0, '111111111', 'Голдън Строй ЕООД', 'BG', 'small', 0, 2, 1, 0, 0, 30),
  ('eop:contracts:2026-06-09', 2026, 'eop', '2026-06-09T00:00:00Z', 0, 'DOC-G6',
   '2026-06-06', 'UNP-G6', 'TENDER-G6', 'open', 'Golden tender 6', '45000000',
   'Construction', 'works', NULL, 'BGN', 'basis', 'lowest',
   'Министерство на тестовата инфраструктура', '100000001', 'public', 'activity', 'notice',
   NULL, 'CN-6', '2026-06-06', 195.583, 'BGN', 'Golden contract 6',
   0, '121396123', 'Български пощи ЕАД', 'BG', 'large', 0, 1, 0, 0, 0, 30),
  ('eop:contracts:2026-06-09', 2026, 'eop', '2026-06-09T00:00:00Z', 0, 'DOC-G7',
   '2026-06-07', 'UNP-G7', 'TENDER-G7', 'open', 'Golden tender 7', '45000000',
   'Construction', 'works', NULL, 'BGN', 'basis', 'lowest',
   'Министерство на тестовата инфраструктура', '100000001', 'public', 'activity', 'notice',
   NULL, 'CN-7', '2026-06-07', 0, 'BGN', 'Golden contract 7',
   0, '111111111', 'Голдън Строй ЕООД', 'BG', 'small', 0, 1, 1, 0, 0, 30),
  ('eop:contracts:2026-06-09', 2026, 'eop', '2026-06-09T00:00:00Z', 0, 'DOC-G8',
   '2026-06-08', 'UNP-G8', 'TENDER-G8', 'open', 'Golden tender 8', '33600000',
   'Pharma', 'supplies', 100000, 'BGN', 'basis', 'lowest',
   'Община Голдънво', '100000002', 'public', 'activity', 'notice',
   NULL, 'CN-8', '2026-06-08', 39116.6, 'BGN', 'Golden contract 8',
   0, '121396123', 'Български пощи ЕАД', 'BG', 'large', 0, 4, 1, 1, 0, 30);

INSERT INTO raw_amendments
  (source, dataset_year, dataset_variant, fetched_at, seq_no, document_number,
   contract_number, contract_date, published_at, unp, authority_eik, authority_name,
   procurement_subject, contract_kind, value_before, value_after, value_delta,
   currency, description)
VALUES
  ('eop:annexes:2026-06-10', 2026, 'eop', '2026-06-10T00:00:00Z', '1', 'AMD-G6',
   'CN-6', '2026-06-06', '2026-06-10', 'UNP-G6', '100000001',
   'Министерство на тестовата инфраструктура', 'Golden tender 6', 'works',
   195.583, 19558.3, 19362.717, 'BGN', 'Suspicious 100x increase'),
  ('eop:annexes:2026-06-12', 2026, 'eop', '2026-06-12T00:00:00Z', '1', 'AMD-G8',
   'CN-8', '2026-06-08', '2026-06-12', 'UNP-G8', '100000002', 'Община Голдънво',
   'Golden tender 8', 'supplies', 39116.6, 58674.9, 19558.3, 'BGN', 'Legitimate 1.5x increase');

INSERT INTO raw_ocds_parties
  (source, fetched_at, ocid, party_id, eik, scheme, name, roles,
   street_address, locality, postal_code, region_nuts, country)
VALUES
  ('ocds:2026-06-09', '2026-06-09T00:00:00Z', 'ocds-golden-1', 'ORG-0001', '100000001',
   'BG-EIK', 'Министерство на тестовата инфраструктура', 'buyer',
   'бул. Тестов 1', 'София', '1000', 'BG411', 'BG');
`;

// ── Golden expected numbers (every figure hand-derived from the fixture above) ─────────────────
const B1 = 'eik:111111111';
const B2 = 'eik:121396123';
const B3 = 'name:SECRET WINNER LTD';
const A1 = 'auth:100000001';
const A2 = 'auth:100000002';

const GOLDEN = {
  // Corpus shape after normalize: 8 tenders (one per УНП), 8 contracts, 3 bidders, 2 authorities,
  // 2 promoted amendments.
  shape: { authorities: 2, tenders: 8, contracts: 8, bidders: 3, amendments: 2 },

  // Per-contract recount — the grain the reconciliation gate structurally cannot check.
  // amount_eur:      c1 195583÷1.95583=100000 | c2 50000 EUR as-is | c3 50000×0.9=45000
  //                  c4 repaired to est 1000  | c5 15000           | c6 falls back to signing 195.583÷1.95583=100
  //                  c7 0÷1.95583=0           | c8 58674.9÷1.95583=30000 (annexed current, 1.5× is legit)
  // signing_value_eur: suppressed (NULL) only for value_suspect (c4).
  // current_value_eur: only c8 has a trusted current (58674.9÷1.95583=30000); c6's annex is the
  //                    suspect part so it is suppressed; the rest have no current_value.
  contracts: [
    {
      id: `c:e:UNP-G1:CN-1:_:${B1}:1`,
      bidder_id: B1,
      amount_eur: 100000,
      value_flag: 'ok',
      signing_value_eur: 100000,
      current_value_eur: null,
      fx_converted: 0,
      fx_rate: null,
      annex_count: 0,
    },
    {
      id: `c:e:UNP-G2:CN-2:_:${B2}:1`,
      bidder_id: B2,
      amount_eur: 50000,
      value_flag: 'ok',
      signing_value_eur: 50000,
      current_value_eur: null,
      fx_converted: 0,
      fx_rate: null,
      annex_count: 0,
    },
    {
      id: `c:e:UNP-G3:CN-3:_:${B1}:1`,
      bidder_id: B1,
      amount_eur: 45000,
      value_flag: 'ok',
      signing_value_eur: 45000,
      current_value_eur: null,
      fx_converted: 1,
      fx_rate: 0.9,
      annex_count: 0,
    },
    {
      id: `c:e:UNP-G4:CN-4:_:${B3}:1`,
      bidder_id: B3,
      amount_eur: 1000,
      value_flag: 'value_suspect',
      signing_value_eur: null,
      current_value_eur: null,
      fx_converted: 0,
      fx_rate: null,
      annex_count: 0,
    },
    {
      id: `c:e:UNP-G5:CN-5:_:${B1}:1`,
      bidder_id: B1,
      amount_eur: 15000,
      value_flag: 'review',
      signing_value_eur: 15000,
      current_value_eur: null,
      fx_converted: 0,
      fx_rate: null,
      annex_count: 0,
    },
    {
      id: `c:e:UNP-G6:CN-6:_:${B2}:1`,
      bidder_id: B2,
      amount_eur: 100,
      value_flag: 'annex_suspect',
      signing_value_eur: 100,
      current_value_eur: null,
      fx_converted: 0,
      fx_rate: null,
      annex_count: 1,
    },
    {
      id: `c:e:UNP-G7:CN-7:_:${B1}:1`,
      bidder_id: B1,
      amount_eur: 0,
      value_flag: 'value_low',
      signing_value_eur: 0,
      current_value_eur: null,
      fx_converted: 0,
      fx_rate: null,
      annex_count: 0,
    },
    {
      id: `c:e:UNP-G8:CN-8:_:${B2}:1`,
      bidder_id: B2,
      amount_eur: 30000,
      value_flag: 'ok',
      signing_value_eur: 20000,
      current_value_eur: 30000,
      fx_converted: 0,
      fx_rate: null,
      annex_count: 1,
    },
  ],

  // ok: c1,c2,c3,c8 — every other flag exactly once.
  valueFlags: [
    { value_flag: 'annex_suspect', n: 1 },
    { value_flag: 'ok', n: 4 },
    { value_flag: 'review', n: 1 },
    { value_flag: 'value_low', n: 1 },
    { value_flag: 'value_suspect', n: 1 },
  ],

  // won_eur:  B1 = c1 100000 + c3 45000 + c5 15000 + c7 0            = 160000 (A1 via G1/G7, A2 via G3/G5 → 2 authorities)
  //           B2 = c2 50000 + c6 100 + c8 30000                       =  80100 (A1 via G2/G6, A2 via G8 → 2)
  //           B3 = c4 1000                                            =   1000
  // primary_sector: B1 cpv45 100000 > cpv33 60000 → '45'; B2 cpv45 50100 > cpv33 30000 → '45'; B3 → '33'.
  // eu_eur: only c2 is eu_funded → B2 50000.
  companyTotals: [
    {
      bidder_id: B1,
      name: 'Голдън Строй ЕООД',
      kind: 'company',
      ownership_kind: null,
      eik: '111111111',
      eik_valid: 1,
      won_eur: 160000,
      contracts: 4,
      authorities: 2,
      primary_sector: '45',
      eu_eur: 0,
      first_date: '2026-06-01',
      last_date: '2026-06-07',
    },
    {
      bidder_id: B2,
      name: 'Български пощи ЕАД',
      kind: 'company',
      ownership_kind: 'state',
      eik: '121396123',
      eik_valid: 1,
      won_eur: 80100,
      contracts: 3,
      authorities: 2,
      primary_sector: '45',
      eu_eur: 50000,
      first_date: '2026-06-02',
      last_date: '2026-06-08',
    },
    {
      bidder_id: B3,
      name: 'SECRET WINNER LTD',
      kind: 'company',
      ownership_kind: null,
      eik: null,
      eik_valid: 0,
      won_eur: 1000,
      contracts: 1,
      authorities: 1,
      primary_sector: '33',
      eu_eur: 0,
      first_date: '2026-06-04',
      last_date: '2026-06-04',
    },
  ],

  // spent_eur: A1 = c1 100000 + c2 50000 + c6 100 + c7 0 = 150100; avg 150100/4 = 37525; suppliers {B1,B2} = 2
  //            A2 = c3 45000 + c4 1000 + c5 15000 + c8 30000 = 91000; avg 91000/4 = 22750; suppliers {B1,B2,B3} = 3
  // A1 settlement/region via its OCDS party (София / BG411) + the real load-nuts.sql row for BG411.
  authorityTotals: [
    {
      authority_id: A1,
      name: 'Министерство на тестовата инфраструктура',
      type_group: 'министерство',
      settlement: 'София',
      region: 'София (столица)',
      spent_eur: 150100,
      contracts: 4,
      suppliers: 2,
      avg_eur: 37525,
      primary_sector: '45',
      eu_eur: 50000,
      first_date: '2026-06-01',
      last_date: '2026-06-07',
    },
    {
      authority_id: A2,
      name: 'Община Голдънво',
      type_group: 'община',
      settlement: null,
      region: null,
      spent_eur: 91000,
      contracts: 4,
      suppliers: 3,
      avg_eur: 22750,
      primary_sector: '33',
      eu_eur: 0,
      first_date: '2026-06-03',
      last_date: '2026-06-08',
    },
  ],

  // cpv45 = c1 100000 + c2 50000 + c6 100 + c7 0 = 150100; cpv33 = c3 45000 + c4 1000 + c5 15000 + c8 30000 = 91000.
  sectorTotals: [
    { division: '33', contracts: 4, value_eur: 91000 },
    { division: '45', contracts: 4, value_eur: 150100 },
  ],

  // value_eur = 150100 + 91000 = 241100; suspect counts value_suspect rows only (c4).
  homeTotals: {
    contracts: 8,
    value_eur: 241100,
    authorities: 2,
    bidders: 3,
    suspect: 1,
    first_date: '2026-06-01',
    last_date: '2026-06-08',
    as_of: '2026-06-08',
  },

  // procedure: all 8 tenders are 'open'. eu: c2 alone is eu_funded (50000); the other 7 sum 191100.
  facetCounts: [
    { facet: 'eu', key: '0', contracts: 7, value_eur: 191100 },
    { facet: 'eu', key: '1', contracts: 1, value_eur: 50000 },
    { facet: 'procedure', key: 'open', contracts: 8, value_eur: 241100 },
  ],

  // A1→B1 c1+c7 = 100000 | A1→B2 c2+c6 = 50100 | A2→B1 c3+c5 = 60000 | A2→B2 c8 = 30000 | A2→B3 c4 = 1000
  flowPairs: [
    { authority_id: A1, bidder_id: B1, won_eur: 100000, contracts: 2 },
    { authority_id: A1, bidder_id: B2, won_eur: 50100, contracts: 2 },
    { authority_id: A2, bidder_id: B1, won_eur: 60000, contracts: 2 },
    { authority_id: A2, bidder_id: B2, won_eur: 30000, contracts: 1 },
    { authority_id: A2, bidder_id: B3, won_eur: 1000, contracts: 1 },
  ],

  // 2 authorities + 3 companies + 8 contracts (all carry a subject) = 13 FTS rows.
  searchIndexRows: 13,

  // All fixture contracts are EOP-sourced; latest signed 2026-06-08.
  dataFreshness: [{ source: 'eop', as_of: '2026-06-08', rows: 8 }],
} as const;

describe('golden dataset (#99): hand-verified totals through the full derive pipeline', () => {
  let dir!: string;
  let db!: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sigma-golden-'));
    db = join(dir, 'golden.sqlite');
    readScript(db, schemaPath);
    readScript(db, workStagingSchemaPath);
    sqlite(db, FIXTURE);
    // Production full-derive order (scripts/import.mjs runFullDerive). load-fx.mjs is network-bound,
    // so the fixture pins its one USD rate inline; nuts/state-owned run as the REAL repo scripts.
    readScript(db, deriveAmendmentsPath);
    readScript(db, loadNutsPath);
    readScript(db, seedStateOwnedPath);
    readScript(db, normalizePath);
    readScript(db, promoteAmendmentsPath);
    readScript(db, precomputePath);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('produces the expected corpus shape', () => {
    const [shape] = sqliteJson<(typeof GOLDEN)['shape']>(
      db,
      `SELECT (SELECT COUNT(*) FROM authorities) AS authorities,
              (SELECT COUNT(*) FROM tenders) AS tenders,
              (SELECT COUNT(*) FROM contracts) AS contracts,
              (SELECT COUNT(*) FROM bidders) AS bidders,
              (SELECT COUNT(*) FROM amendments) AS amendments`,
    );
    expect(shape).toEqual(GOLDEN.shape);
    expect(sqliteJson(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('recounts every contract: identity, amount_eur, value_flag, EUR timeline', () => {
    const rows = sqliteJson(
      db,
      `SELECT id, bidder_id, ROUND(amount_eur, 2) AS amount_eur, value_flag,
              ROUND(signing_value_eur, 2) AS signing_value_eur,
              ROUND(current_value_eur, 2) AS current_value_eur,
              fx_converted, ROUND(fx_rate, 4) AS fx_rate, annex_count
       FROM contracts ORDER BY id`,
    );
    expect(rows).toEqual(GOLDEN.contracts);
  });

  it('matches the value_flag distribution', () => {
    const rows = sqliteJson(
      db,
      'SELECT value_flag, COUNT(*) AS n FROM contracts GROUP BY value_flag ORDER BY value_flag',
    );
    expect(rows).toEqual(GOLDEN.valueFlags);
  });

  it('matches company_totals per bidder', () => {
    const rows = sqliteJson(
      db,
      `SELECT bidder_id, name, kind, ownership_kind, eik, eik_valid, ROUND(won_eur, 2) AS won_eur,
              contracts, authorities, primary_sector, ROUND(eu_eur, 2) AS eu_eur, first_date, last_date
       FROM company_totals ORDER BY bidder_id`,
    );
    expect(rows).toEqual(GOLDEN.companyTotals);
  });

  it('matches authority_totals per authority', () => {
    const rows = sqliteJson(
      db,
      `SELECT authority_id, name, type_group, settlement, region, ROUND(spent_eur, 2) AS spent_eur,
              contracts, suppliers, ROUND(avg_eur, 2) AS avg_eur, primary_sector,
              ROUND(eu_eur, 2) AS eu_eur, first_date, last_date
       FROM authority_totals ORDER BY authority_id`,
    );
    expect(rows).toEqual(GOLDEN.authorityTotals);
  });

  it('matches sector_totals, facet_counts and flow_pairs', () => {
    expect(
      sqliteJson(
        db,
        `SELECT division, contracts, ROUND(value_eur, 2) AS value_eur
         FROM sector_totals ORDER BY division`,
      ),
    ).toEqual(GOLDEN.sectorTotals);
    expect(
      sqliteJson(
        db,
        `SELECT facet, key, contracts, ROUND(value_eur, 2) AS value_eur
         FROM facet_counts ORDER BY facet, key`,
      ),
    ).toEqual(GOLDEN.facetCounts);
    expect(
      sqliteJson(
        db,
        `SELECT authority_id, bidder_id, ROUND(won_eur, 2) AS won_eur, contracts
         FROM flow_pairs ORDER BY authority_id, bidder_id`,
      ),
    ).toEqual(GOLDEN.flowPairs);
  });

  it('matches home_totals', () => {
    const [row] = sqliteJson(
      db,
      `SELECT contracts, ROUND(value_eur, 2) AS value_eur, authorities, bidders, suspect,
              first_date, last_date, as_of
       FROM home_totals WHERE id = 1`,
    );
    expect(row).toEqual(GOLDEN.homeTotals);
  });

  it('indexes the expected search surface and freshness boundary', () => {
    const [count] = sqliteJson<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM search_index');
    expect(count).toEqual({ n: GOLDEN.searchIndexRows });
    expect(
      sqliteJson(db, 'SELECT source, as_of, rows FROM data_freshness ORDER BY source'),
    ).toEqual(GOLDEN.dataFreshness);
  });

  it('passes the reconciliation gate (the two nets are complementary)', () => {
    const run = (sql: string) => sqliteJson<Record<string, unknown>>(db, sql);
    const results = assertIntegrity(run, { label: 'golden-dataset', exit: false }) as Array<{
      name: string;
      ok: boolean;
    }>;
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) expect(result).toMatchObject({ ok: true });
  });
});
