/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertIntegrity } from '../../../scripts/integrity-checks.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const schemaPath = resolve(root, 'packages/db/migrations/0000_init.sql');
const migration1Path = resolve(root, 'packages/db/migrations/0001_flow_pairs_bidder_index.sql');
const migration2Path = resolve(root, 'packages/db/migrations/0002_current_value_currency.sql');
const refreshSlicePath = resolve(root, 'scripts/refresh-slice.sql');
const normalizePath = resolve(root, 'scripts/normalize-raw.sql');
const deriveAmendmentsPath = resolve(root, 'scripts/derive-amendments.sql');
const promoteAmendmentsPath = resolve(root, 'scripts/promote-amendments.sql');
const precomputePath = resolve(root, 'scripts/precompute.sql');
const workStagingSchemaPath = resolve(root, 'scripts/work-staging-schema.sql');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
}

function sqliteJson<T>(dbPath: string, sql: string): T[] {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
  return out ? (JSON.parse(out) as T[]) : [];
}

function sqlValue(value: string | number | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', [dbPath], {
    input: `PRAGMA foreign_keys=ON;\n.read ${path}\n`,
    stdio: 'pipe',
  });
}

function resetRawStaging(dbPath: string): void {
  const rows = sqliteJson<{ name: string }>(
    dbPath,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'raw_%' ORDER BY name DESC",
  );
  for (const row of rows) sqlite(dbPath, `DROP TABLE IF EXISTS "${row.name}";`);
  readScript(dbPath, workStagingSchemaPath);
}

function dropRawStaging(dbPath: string): void {
  const rows = sqliteJson<{ name: string }>(
    dbPath,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'raw_%' ORDER BY name DESC",
  );
  for (const row of rows) sqlite(dbPath, `DROP TABLE IF EXISTS "${row.name}";`);
}

function seedEopBaseDay(dbPath: string): void {
  sqlite(
    dbPath,
    `PRAGMA foreign_keys=ON;
INSERT INTO raw_tenders
  (source, dataset_year, fetched_at, unp, tender_id, procedure_type, procurement_subject,
   cpv_code, cpv_description, contract_kind, estimated_value, currency, legal_basis,
   award_criteria, authority_name, authority_eik, authority_type, main_activity, deadline,
   notice_type, lot_id, lot_name, num_lots, eu_funded, published_at)
VALUES
  ('eop:tenders:2026-06-01', 2026, '2026-06-07T00:00:00Z', 'UNP-CE-1', 'TENDER-CE-1',
   'open', 'Base tender', '45000000', 'Construction', 'works', 2000, 'BGN', 'basis',
   'lowest', 'Authority CE', '123456786', 'public', 'activity', '2026-06-10', 'notice',
   NULL, NULL, 1, 0, '2026-06-01'),
  ('eop:tenders:2026-06-01', 2026, '2026-06-07T00:00:00Z', 'UNP-CE-1', 'TENDER-CE-1',
   'open', 'Base tender', '45000000', 'Construction', 'works', 2000, 'BGN', 'basis',
   'lowest', 'Authority CE', '123456786', 'public', 'activity', '2026-06-10', 'notice',
   '1', 'Lot 1', 1, 0, '2026-06-01');

INSERT INTO raw_contracts
  (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
   published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
   cpv_description, contract_kind, estimated_value, procurement_currency, legal_basis,
   award_criteria, authority_name, authority_eik, authority_type, main_activity, notice_type,
   lot_id, contract_number, contract_date, signing_value, currency, contract_subject,
   awarded_to_group, contractor_eik, contractor_name, contractor_country, winner_size,
   eu_funded, bids_received, bids_sme, bids_rejected, bids_non_eea, duration_days)
VALUES
  ('eop:contracts:2026-06-01', 2026, 'eop', '2026-06-07T00:00:00Z', 0, 'DOC-CE-1',
   '2026-06-01', 'UNP-CE-1', 'TENDER-CE-1', 'open', 'Base tender', '45000000',
   'Construction', 'works', 2000, 'BGN', 'basis', 'lowest', 'Authority CE', '123456786',
   'public', 'activity', 'notice', '1', 'CONTRACT-CE-1', '2026-06-02', 1000, 'BGN',
   'Base contract', 0, '987654308', 'Bidder CE', 'BG', 'small', 0, 3, 1, 0, 0, 30),
  ('ocds:2026-06-01', 2026, 'ocds', '2026-06-07T00:00:00Z', 0, 'DOC-CO-1',
   '2026-06-01', 'OCDS-CO-1', 'TENDER-CO-1', 'open', 'OCDS tender', '45000000',
   'Construction', 'works', 5000, 'BGN', 'basis', 'lowest', 'Authority CE', '123456786',
   'public', 'activity', 'notice', NULL, 'CONTRACT-CO-1', '2026-06-02', 1000, 'BGN',
   'OCDS contract', 0, '987654322', 'Bidder CO', 'BG', 'small', 0, 3, 1, 0, 0, 30);

INSERT INTO raw_amendments
  (source, dataset_year, dataset_variant, fetched_at, seq_no, document_number,
   contract_number, contract_date, published_at, unp, authority_eik, authority_name,
   procurement_subject, contract_kind, value_before, value_after, value_delta,
   currency, description)
VALUES
  ('eop:annexes:2026-06-01', 2026, 'eop', '2026-06-07T00:00:00Z', '1', 'AMD-CE-1',
   'CONTRACT-CE-1', '2026-06-02', '2026-06-03', 'UNP-CE-1', '123456786', 'Authority CE',
   'Base tender', 'works', 1000, 1200, 200, 'BGN', 'Increase'),
  ('ocds:2026-06-01', 2026, 'ocds', '2026-06-07T00:00:00Z', '1', 'AMD-CO-1',
   'CONTRACT-CO-1', '2026-06-02', '2026-06-03', 'OCDS-CO-1', '123456786', 'Authority CE',
   'OCDS tender', 'works', 1000, 1300, 300, 'BGN', 'OCDS increase');
`,
  );
}

function seedRepeatedAnnexOnly(dbPath: string): void {
  sqlite(
    dbPath,
    `INSERT INTO raw_amendments
      (source, dataset_year, dataset_variant, fetched_at, seq_no, document_number,
       contract_number, contract_date, published_at, unp, authority_eik, authority_name,
       procurement_subject, contract_kind, value_before, value_after, value_delta,
       currency, description)
    VALUES
      ('eop:annexes:2026-06-02', 2026, 'eop', '2026-06-08T00:00:00Z', '1', 'AMD-CE-1',
       'CONTRACT-CE-1', '2026-06-02', '2026-06-03', 'UNP-CE-1', '123456786', 'Authority CE',
       'Base tender', 'works', 1000, 1200, 200, 'BGN', 'Increase');`,
  );
}

function seedEopOnlySharedNumber(dbPath: string): void {
  sqlite(
    dbPath,
    `INSERT INTO raw_tenders
      (source, dataset_year, fetched_at, unp, tender_id, procedure_type, procurement_subject,
       cpv_code, cpv_description, contract_kind, estimated_value, currency, legal_basis,
       award_criteria, authority_name, authority_eik, authority_type, main_activity, deadline,
       notice_type, lot_id, lot_name, num_lots, eu_funded, published_at)
    VALUES
      ('eop:tenders:2026-06-01', 2026, '2026-06-07T00:00:00Z', 'UNP-SHARED', 'TENDER-SHARED',
       'open', 'Shared tender', '45000000', 'Construction', 'works', 5000, 'BGN', 'basis',
       'lowest', 'Authority Shared', '223456787', 'public', 'activity', '2026-06-10', 'notice',
       NULL, NULL, 1, 0, '2026-06-01');

    INSERT INTO raw_contracts
      (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
       published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
       cpv_description, contract_kind, estimated_value, procurement_currency, legal_basis,
       award_criteria, authority_name, authority_eik, authority_type, main_activity, notice_type,
       lot_id, contract_number, contract_date, signing_value, currency, contract_subject,
       awarded_to_group, contractor_eik, contractor_name, contractor_country, winner_size,
       eu_funded, bids_received, bids_sme, bids_rejected, bids_non_eea, duration_days)
    VALUES
      ('eop:contracts:2026-06-01', 2026, 'eop', '2026-06-07T00:00:00Z', 0, 'DOC-SHARED',
       '2026-06-01', 'UNP-SHARED', 'TENDER-SHARED', 'open', 'Shared tender', '45000000',
       'Construction', 'works', 5000, 'BGN', 'basis', 'lowest', 'Authority Shared', '223456787',
       'public', 'activity', 'notice', NULL, 'CONTRACT-SHARED', '2026-06-02', 1000, 'BGN',
       'Shared contract', 0, '887654321', 'Bidder Shared', 'BG', 'small', 0, 3, 1, 0, 0, 30);`,
  );
}

function seedOcdsOnlySharedNumber(dbPath: string): void {
  sqlite(
    dbPath,
    `INSERT INTO raw_contracts
      (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
       published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
       cpv_description, contract_kind, estimated_value, procurement_currency, legal_basis,
       award_criteria, authority_name, authority_eik, authority_type, main_activity, notice_type,
       lot_id, contract_number, contract_date, signing_value, currency, contract_subject,
       awarded_to_group, contractor_eik, contractor_name, contractor_country, winner_size,
       eu_funded, bids_received, bids_sme, bids_rejected, bids_non_eea, duration_days)
    VALUES
      ('ocds:2026-06-02', 2026, 'ocds', '2026-06-08T00:00:00Z', 0, 'DOC-SHARED-O',
       '2026-06-02', 'OCDS-SHARED', 'TENDER-SHARED-O', 'open', 'Shared tender ocds', '45000000',
       'Construction', 'works', 5000, 'BGN', 'basis', 'lowest', 'Authority Shared', '223456787',
       'public', 'activity', 'notice', NULL, 'CONTRACT-SHARED', '2026-06-02', 1000, 'BGN',
       'Shared contract ocds', 0, '887654321', 'Bidder Shared', 'BG', 'small', 0, 3, 1, 0, 0, 30);`,
  );
}

function initWorkDb(dbPath: string): void {
  readScript(dbPath, schemaPath);
  readScript(dbPath, migration1Path);
  readScript(dbPath, migration2Path);
  readScript(dbPath, workStagingSchemaPath);
}

function seedCrossCurrencyAmendment(dbPath: string): void {
  sqlite(
    dbPath,
    `INSERT INTO raw_tenders
      (source, dataset_year, fetched_at, unp, tender_id, procedure_type, procurement_subject,
       cpv_code, cpv_description, contract_kind, estimated_value, currency, authority_name,
       authority_eik, authority_type, published_at)
    VALUES
      ('eop:tenders:2025-06-01', 2025, '2026-06-08T00:00:00Z', 'UNP-CROSS-CURRENCY',
       'TENDER-CROSS-CURRENCY', 'open', 'Cross-currency tender', '45000000', 'Construction',
       'works', 300000000, 'EUR', 'Authority Cross Currency', '133456789', 'public',
       '2025-06-01');

    INSERT INTO raw_contracts
      (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
       published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
       cpv_description, contract_kind, estimated_value, procurement_currency, authority_name,
       authority_eik, authority_type, contract_number, contract_date, signing_value, currency,
       contract_subject, awarded_to_group, contractor_eik, contractor_name)
    VALUES
      ('eop:contracts:2025-06-01', 2025, 'eop', '2026-06-08T00:00:00Z', 0,
       'DOC-CROSS-CURRENCY', '2025-06-01', 'UNP-CROSS-CURRENCY', 'TENDER-CROSS-CURRENCY',
       'open', 'Cross-currency tender', '45000000', 'Construction', 'works', 300000000,
       'EUR', 'Authority Cross Currency', '133456789', 'public', 'CONTRACT-CROSS-CURRENCY',
       '2025-06-02', 136580250, 'BGN', 'Cross-currency contract', 0, '997654321',
       'Bidder Cross Currency');

    INSERT INTO raw_amendments
      (source, dataset_year, dataset_variant, fetched_at, seq_no, document_number,
       contract_number, contract_date, published_at, unp, authority_eik, authority_name,
       procurement_subject, contract_kind, value_before, value_after, value_delta, currency,
       description)
    VALUES
      ('eop:annexes:2026-06-01', 2026, 'eop', '2026-06-08T00:00:00Z', '1',
       'AMD-CROSS-CURRENCY', 'CONTRACT-CROSS-CURRENCY', '2025-06-02', '2026-06-03',
       'UNP-CROSS-CURRENCY', '133456789', 'Authority Cross Currency', 'Cross-currency tender',
       'works', 136580250, 104748559.44, -31831690.56, 'EUR',
       'Post-switch EUR amendment');`,
  );
}

function seedCrossCurrencyFlagBoundary(dbPath: string): void {
  sqlite(
    dbPath,
    `INSERT INTO raw_tenders
      (source, dataset_year, fetched_at, unp, tender_id, procedure_type, procurement_subject,
       cpv_code, estimated_value, currency, authority_name, authority_eik, authority_type)
    VALUES
      ('eop:tenders:2025-06-01', 2025, '2026-06-08T00:00:00Z', 'UNP-FX-FLAG',
       'TENDER-FX-FLAG', 'open', 'Currency flag tender', '45000000', 1500, 'EUR',
       'Authority Currency Flag', '143456789', 'public');
    INSERT INTO raw_contracts
      (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, unp, tender_ext_id,
       procedure_type, procurement_subject, cpv_code, estimated_value, procurement_currency,
       authority_name, authority_eik, authority_type, contract_number, contract_date, signing_value,
       currency, contract_subject, awarded_to_group, contractor_eik, contractor_name)
    VALUES
      ('eop:contracts:2025-06-01', 2025, 'eop', '2026-06-08T00:00:00Z', 0,
       'UNP-FX-FLAG', 'TENDER-FX-FLAG', 'open', 'Currency flag tender', '45000000', 1500,
       'EUR', 'Authority Currency Flag', '143456789', 'public', 'CONTRACT-FX-FLAG',
       '2025-06-02', 10000, 'BGN', 'Currency flag contract', 0, '987654322',
       'Bidder Currency Flag');
    INSERT INTO raw_amendments
      (source, dataset_year, dataset_variant, fetched_at, document_number, contract_number,
       published_at, unp, value_before, value_after, value_delta, currency)
    VALUES
      ('eop:annexes:2026-06-01', 2026, 'eop', '2026-06-08T00:00:00Z', 'AMD-FX-FLAG',
       'CONTRACT-FX-FLAG', '2026-06-03', 'UNP-FX-FLAG', 10000, 20000, 10000, 'EUR');`,
  );
}

function seedContractIdFixture(dbPath: string): void {
  sqlite(
    dbPath,
    `INSERT INTO raw_tenders
      (source, dataset_year, fetched_at, unp, tender_id, procedure_type, procurement_subject,
       cpv_code, cpv_description, contract_kind, estimated_value, currency, legal_basis,
       award_criteria, authority_name, authority_eik, authority_type, main_activity, deadline,
       notice_type, lot_id, lot_name, num_lots, eu_funded, published_at)
    VALUES
      ('eop:tenders:2026-06-01', 2026, '2026-06-07T00:00:00Z', 'UNP-ID', 'TENDER-ID',
       'open', 'ID tender', '45000000', 'Construction', 'works', 10000, 'BGN', 'basis',
       'lowest', 'Authority ID', '523456782', 'public', 'activity', '2026-06-10', 'notice',
       NULL, NULL, 1, 0, '2026-06-01'),
      ('eop:tenders:2026-06-01', 2026, '2026-06-07T00:00:00Z', 'UNP-ID', 'TENDER-ID',
       'open', 'ID tender', '45000000', 'Construction', 'works', 10000, 'BGN', 'basis',
       'lowest', 'Authority ID', '523456782', 'public', 'activity', '2026-06-10', 'notice',
       '1', 'Lot 1', 1, 0, '2026-06-01');

    INSERT INTO raw_contracts
      (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
       published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
       cpv_description, contract_kind, estimated_value, procurement_currency, legal_basis,
       award_criteria, authority_name, authority_eik, authority_type, main_activity, notice_type,
       lot_id, contract_number, contract_date, signing_value, currency, contract_subject,
       awarded_to_group, contractor_eik, contractor_name, contractor_country, winner_size,
       eu_funded, bids_received, bids_sme, bids_rejected, bids_non_eea, duration_days)
    VALUES
      ('eop:contracts:2026-06-01', 2026, 'eop', '2026-06-07T00:00:00Z', 0, 'DOC-OLD',
       '2026-06-01', 'UNP-ID', 'TENDER-ID', 'open', 'ID tender', '45000000',
       'Construction', 'works', 10000, 'BGN', 'basis', 'lowest', 'Authority ID', '523456782',
       'public', 'activity', 'notice', '1', 'CONTRACT-ID', '2026-06-02', 1000, 'BGN',
       'Old duplicate', 0, '577777760', 'Bidder ID', 'BG', 'small', 0, 3, 1, 0, 0, 30),
      ('eop:contracts:2026-06-02', 2026, 'eop', '2026-06-08T00:00:00Z', 0, 'DOC-NEW',
       '2026-06-02', 'UNP-ID', 'TENDER-ID', 'open', 'ID tender', '45000000',
       'Construction', 'works', 10000, 'BGN', 'basis', 'lowest', 'Authority ID', '523456782',
       'public', 'activity', 'notice', '1', 'CONTRACT-ID', '2026-06-02', 1000, 'BGN',
       'New duplicate', 0, '577777760', 'Bidder ID', 'BG', 'small', 0, 3, 1, 0, 0, 30),
      ('eop:contracts:2026-06-02', 2026, 'eop', '2026-06-08T00:00:00Z', 0, 'DOC-NULL',
       '2026-06-02', 'UNP-ID', 'TENDER-ID', 'open', 'ID tender', '45000000',
       'Construction', 'works', 10000, 'BGN', 'basis', 'lowest', 'Authority ID', '523456782',
       'public', 'activity', 'notice', NULL, NULL, '2026-06-03', 500, 'BGN',
       'Null number', 0, '577777778', 'Bidder Null', 'BG', 'small', 0, 1, 1, 0, 0, 30),
      ('ocds:2026-06-02', 2026, 'ocds', '2026-06-08T00:00:00Z', 0, 'DOC-OCDS',
       '2026-06-02', 'OCDS-ID', 'TENDER-OCDS', 'open', 'OCDS ID tender', '45000000',
       'Construction', 'works', 10000, 'BGN', 'basis', 'lowest', 'Authority ID', '523456782',
       'public', 'activity', 'notice', 'LOT-0001', 'CONTRACT-OCDS', '2026-06-04', 700, 'BGN',
       'OCDS ID', 0, '577777792', 'Bidder OCDS', 'BG', 'small', 0, 2, 1, 0, 0, 30),
      ('ocds:2026-06-02', 2026, 'ocds', '2026-06-08T00:00:00Z', 0, 'DOC-OCDS-SKIP',
       '2026-06-02', 'OCDS-ID-SKIP', 'TENDER-OCDS-SKIP', 'open', 'OCDS skip tender', '45000000',
       'Construction', 'works', 10000, 'BGN', 'basis', 'lowest', 'Authority ID', '523456782',
       'public', 'activity', 'notice', NULL, 'CONTRACT-ID', '2026-06-04', 700, 'BGN',
       'OCDS skip', 0, '577777760', 'Bidder ID', 'BG', 'small', 0, 2, 1, 0, 0, 30);`,
  );
}

function seedSyntheticWindow(
  dbPath: string,
  values: {
    unp: string;
    source: string;
    subject: string | null;
    cpv: string | null;
    estimated: number | null;
    currency: string | null;
  },
): void {
  sqlite(
    dbPath,
    `INSERT INTO raw_contracts
      (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
       published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
       cpv_description, contract_kind, estimated_value, procurement_currency, legal_basis,
       award_criteria, authority_name, authority_eik, authority_type, main_activity, notice_type,
       lot_id, contract_number, contract_date, signing_value, currency, contract_subject,
       awarded_to_group, contractor_eik, contractor_name, contractor_country, winner_size,
       eu_funded, bids_received, bids_sme, bids_rejected, bids_non_eea, duration_days)
    VALUES
      (${sqlValue(values.source)}, 2026, 'eop', '2026-06-08T00:00:00Z', 0, ${sqlValue(`DOC-${values.source}`)},
       '2026-06-02', ${sqlValue(values.unp)}, ${sqlValue(`TENDER-${values.unp}`)}, 'open',
       ${sqlValue(values.subject)}, ${sqlValue(values.cpv)},
       'Construction', 'works', ${sqlValue(values.estimated)}, ${sqlValue(values.currency)},
       'basis', 'lowest', 'Authority Synthetic', '623456780', 'public', 'activity', 'notice',
       NULL, ${sqlValue(`CONTRACT-${values.source}`)}, '2026-06-02', 100, ${sqlValue(values.currency)},
       'Synthetic contract', 0, '667777777', 'Bidder Synthetic', 'BG', 'small', 0, 1, 1, 0, 0, 30);`,
  );
}

function seedSyntheticAuthority(dbPath: string): void {
  sqlite(
    dbPath,
    `INSERT OR IGNORE INTO authorities (id, name, bulstat, type, type_group)
     VALUES ('auth:623456780', 'Authority Synthetic', '623456780', 'public', 'other');`,
  );
}

function seedReplayParty(dbPath: string): void {
  sqlite(
    dbPath,
    `INSERT INTO raw_ocds_parties
      (source, fetched_at, ocid, party_id, eik, name, street_address, locality,
       region_nuts, contact_email, contact_phone)
    VALUES
      ('ocds:2026-06-01', '2026-06-08T00:00:00Z', 'ocds-replay', 'party-replay',
       '823456782', 'Replay party', 'Replay street 1', 'Replay city', 'BG411',
       'replay@example.test', '+359000000001'),
      ('ocds:2026-06-01', '2026-06-08T00:00:00Z', NULL, NULL,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL);`,
  );
}

function seedReplayEntity(dbPath: string): void {
  sqlite(
    dbPath,
    `INSERT INTO raw_contracts
      (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
       published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
       cpv_description, contract_kind, estimated_value, procurement_currency, legal_basis,
       award_criteria, authority_name, authority_eik, authority_type, main_activity, notice_type,
       lot_id, contract_number, contract_date, signing_value, currency, contract_subject,
       awarded_to_group, contractor_eik, contractor_name, contractor_country, winner_size,
       eu_funded, bids_received, bids_sme, bids_rejected, bids_non_eea, duration_days)
    VALUES
      ('eop:contracts:2026-06-02', 2026, 'eop', '2026-06-08T00:00:00Z', 0, 'DOC-REPLAY',
       '2026-06-02', 'UNP-REPLAY', 'TENDER-REPLAY', 'open', 'Replay tender', '45000000',
       'Construction', 'works', 1000, 'BGN', 'basis', 'lowest', 'Replay authority', '823456782',
       'public', 'activity', 'notice', NULL, 'CONTRACT-REPLAY', '2026-06-02', 100, 'BGN',
       'Replay contract', 0, '823456782', 'Replay bidder', 'BG', 'small', 0, 1, 1, 0, 0, 30);`,
  );
}

// Two genuinely-distinct companies that happen to occupy the SAME OCDS positional slot
// (ocid + party_id) on different republish days — the real-world hazard where `ORG-0003`
// means "the 3rd party in THIS package" and the slot is reused per republish. `B` carries the
// later source, so a source-DESC dedup on an (ocid, party_id)-only key would drop `A` entirely.
function seedCollidingPartySlot(dbPath: string): void {
  sqlite(
    dbPath,
    `INSERT INTO raw_ocds_parties
      (source, fetched_at, ocid, party_id, eik, name, street_address, locality,
       region_nuts, contact_email, contact_phone)
    VALUES
      ('ocds:2026-06-01', '2026-06-08T00:00:00Z', 'ocds-shared', 'ORG-0003',
       '111111113', 'Company A', 'Addr A 1', 'City A', 'BG331', 'a@example.test', '+359000000011'),
      ('ocds:2026-06-05', '2026-06-08T00:00:00Z', 'ocds-shared', 'ORG-0003',
       '222222226', 'Company B', 'Addr B 2', 'City B', 'BG421', 'b@example.test', '+359000000022');`,
  );
}

function seedTwoCollidingBidders(dbPath: string): void {
  for (const [eik, name] of [
    ['111111113', 'Company A'],
    ['222222226', 'Company B'],
  ] as const) {
    sqlite(
      dbPath,
      `INSERT INTO raw_contracts
        (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
         published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
         cpv_description, contract_kind, estimated_value, procurement_currency, legal_basis,
         award_criteria, authority_name, authority_eik, authority_type, main_activity, notice_type,
         lot_id, contract_number, contract_date, signing_value, currency, contract_subject,
         awarded_to_group, contractor_eik, contractor_name, contractor_country, winner_size,
         eu_funded, bids_received, bids_sme, bids_rejected, bids_non_eea, duration_days)
      VALUES
        (${sqlValue(`eop:contracts:2026-06-02:${eik}`)}, 2026, 'eop', '2026-06-08T00:00:00Z', 0,
         ${sqlValue(`DOC-${eik}`)}, '2026-06-02', ${sqlValue(`UNP-${eik}`)}, ${sqlValue(`TENDER-${eik}`)},
         'open', 'Slot tender', '45000000', 'Construction', 'works', 1000, 'BGN', 'basis', 'lowest',
         'Slot authority', '923456783', 'public', 'activity', 'notice', NULL,
         ${sqlValue(`CONTRACT-${eik}`)}, '2026-06-02', 100, 'BGN', 'Slot contract', 0,
         ${sqlValue(eik)}, ${sqlValue(name)}, 'BG', 'small', 0, 1, 1, 0, 0, 30);`,
    );
  }
}

function seedJointAuthorityFixture(dbPath: string, refresh: boolean): void {
  if (refresh) {
    sqlite(
      dbPath,
      `INSERT INTO authorities (id, name, bulstat, type)
         VALUES ('auth:222222222', 'Second Authority', '222222222', 'public');
       INSERT INTO tenders
         (id, source_id, title, authority_id, currency, procedure_type, status)
         VALUES
         ('t:00080-2023-0001', '00080-2023-0001', 'Historical prefix observation',
          'auth:222222222', 'EUR', 'open', 'published');`,
    );
  }

  sqlite(
    dbPath,
    `INSERT INTO raw_tenders
      (source, dataset_year, fetched_at, unp, tender_id, procedure_type, procurement_subject,
       estimated_value, currency, authority_name, authority_eik, authority_type, lot_id, published_at)
    VALUES
      ('eop:tenders:2024-01-01', 2024, '2024-01-02T00:00:00Z', '00080-2023-0001',
       'TENDER-PREFIX-HISTORY', 'open', 'Historical prefix observation', 1000, 'EUR',
       'Second Authority', '222222222', 'public', NULL, '2023-01-01'),
      ('eop:tenders:2024-01-01', 2024, '2024-01-02T00:00:00Z', '99999-2023-0001',
       'TENDER-NAME-HISTORY', 'open', 'Historical name observation', 1000, 'EUR',
       'First Authority', '111111111', 'public', NULL, '2023-01-01'),
      ('eop:tenders:2024-01-01', 2024, '2024-01-02T00:00:00Z', '00080-2024-0030',
       'TENDER-JOINT-PREFIX', 'open', 'Prefix-led joint tender', 1000, 'EUR',
       'First Authority', '111111111;222222222', 'public', NULL, '2024-01-01'),
      ('eop:tenders:2024-01-01', 2024, '2024-01-02T00:00:00Z', 'UNRESOLVED-2024-0001',
       'TENDER-JOINT-FALLBACK', 'open', 'Fallback joint tender', 1000, 'EUR',
       'Third Authority', '333333333;444444444', 'public', NULL, '2024-01-01');

    INSERT INTO raw_contracts
      (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
       published_at, unp, tender_ext_id, procedure_type, procurement_subject, estimated_value,
       procurement_currency, authority_name, authority_eik, authority_type, contract_number,
       contract_date, signing_value, currency, contract_subject, awarded_to_group,
       contractor_eik, contractor_name, eu_funded, bids_received)
    VALUES
      ('eop:contracts:2024-01-01', 2024, 'eop', '2024-01-02T00:00:00Z', 0,
       'DOC-JOINT-PREFIX', '2024-01-01', '00080-2024-0030', 'TENDER-JOINT-PREFIX', 'open',
       'Prefix-led joint tender', 1000, 'EUR', 'First Authority', '111111111;222222222',
       'public', 'CONTRACT-JOINT-PREFIX', '2024-01-02', 100, 'EUR', 'Prefix-led contract', 0,
       '777777777', 'Joint Bidder', 0, 1),
      ('eop:contracts:2024-01-01', 2024, 'eop', '2024-01-02T00:00:00Z', 0,
       'DOC-JOINT-FALLBACK', '2024-01-01', 'UNRESOLVED-2024-0001',
       'TENDER-JOINT-FALLBACK', 'open', 'Fallback joint tender', 1000, 'EUR',
       'Third Authority', '333333333;444444444', 'public', 'CONTRACT-JOINT-FALLBACK',
       '2024-01-02', 200, 'EUR', 'Fallback contract', 0, '777777777', 'Joint Bidder', 0, 1);`,
  );
}

describe('joint-procurement authority attribution', () => {
  it.each([
    ['full normalize', false],
    ['slice refresh', true],
  ] as const)(
    'uses the УНП prefix and keeps participation value non-summable on %s',
    (_label, refresh) => {
      const dir = mkdtempSync(resolve(tmpdir(), 'sigma-joint-authorities-'));
      const dbPath = resolve(dir, 'test.sqlite');
      try {
        initWorkDb(dbPath);
        seedJointAuthorityFixture(dbPath, refresh);
        readScript(dbPath, refresh ? refreshSlicePath : normalizePath);
        if (!refresh) readScript(dbPath, precomputePath);

        expect(
          sqliteJson<{ source_id: string; authority_id: string }>(
            dbPath,
            `SELECT source_id, authority_id FROM tenders
             WHERE source_id IN ('00080-2024-0030', 'UNRESOLVED-2024-0001')
             ORDER BY source_id`,
          ),
        ).toEqual([
          { source_id: '00080-2024-0030', authority_id: 'auth:222222222' },
          { source_id: 'UNRESOLVED-2024-0001', authority_id: 'auth:333333333' },
        ]);

        expect(
          sqliteJson<{ source_id: string; authority_id: string; ordinal: number }>(
            dbPath,
            `SELECT t.source_id, cca.authority_id, cca.ordinal
             FROM contract_co_authorities cca
             JOIN contracts c ON c.id = cca.contract_id
             JOIN tenders t ON t.id = c.tender_id
             WHERE cca.ordinal = 0
             ORDER BY t.source_id`,
          ),
        ).toEqual([
          { source_id: '00080-2024-0030', authority_id: 'auth:222222222', ordinal: 0 },
          { source_id: 'UNRESOLVED-2024-0001', authority_id: 'auth:333333333', ordinal: 0 },
        ]);

        expect(
          sqliteJson<{
            authority_id: string;
            joint_contract_participations: number;
            joint_contract_value_eur: number;
          }>(
            dbPath,
            `SELECT authority_id, joint_contract_participations, joint_contract_value_eur
             FROM authority_joint_participation
             WHERE authority_id IN ('auth:111111111', 'auth:222222222')
             ORDER BY authority_id`,
          ),
        ).toEqual([
          {
            authority_id: 'auth:111111111',
            joint_contract_participations: 1,
            joint_contract_value_eur: 100,
          },
          {
            authority_id: 'auth:222222222',
            joint_contract_participations: 1,
            joint_contract_value_eur: 100,
          },
        ]);

        expect(
          sqliteJson<{ spent_eur: number }>(
            dbPath,
            `SELECT COALESCE((SELECT spent_eur FROM authority_totals
               WHERE authority_id = 'auth:111111111'), 0) AS spent_eur`,
          )[0]?.spent_eur,
        ).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('refresh-slice EOP base derivation', () => {
  it('derives new eop base rows as c:e contracts and is idempotent', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-refresh-slice-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      readScript(dbPath, schemaPath);
      readScript(dbPath, migration1Path);
      readScript(dbPath, migration2Path);
      readScript(dbPath, workStagingSchemaPath);
      seedEopBaseDay(dbPath);

      readScript(dbPath, refreshSlicePath);

      const firstContracts = sqliteJson<{ id: string; amount_eur: number }>(
        dbPath,
        "SELECT id, amount_eur FROM contracts WHERE id GLOB 'c:e:*' ORDER BY id",
      );
      expect(firstContracts.length).toBeGreaterThan(0);
      expect(firstContracts[0]?.amount_eur).toBeCloseTo(1200 / 1.95583, 6);
      expect(sqliteJson<{ n: number }>(dbPath, 'SELECT COUNT(*) AS n FROM amendments')[0]?.n).toBe(
        2,
      );
      expect(
        sqliteJson<{ annex_count: number; current_value: number }>(
          dbPath,
          "SELECT annex_count, current_value FROM contracts WHERE id GLOB 'c:e:*'",
        )[0],
      ).toEqual({ annex_count: 1, current_value: 1200 });
      const ocdsContract = sqliteJson<{
        annex_count: number;
        current_value: number;
        amount_eur: number;
      }>(
        dbPath,
        "SELECT annex_count, current_value, amount_eur FROM contracts WHERE id GLOB 'c:o:*'",
      )[0];
      expect(ocdsContract?.annex_count).toBe(1);
      expect(ocdsContract?.current_value).toBe(1300);
      expect(ocdsContract?.amount_eur).toBeCloseTo(1300 / 1.95583, 6);

      expect(
        sqliteJson<{ n: number }>(dbPath, 'SELECT COUNT(*) AS n FROM company_totals')[0]?.n,
      ).toBe(2);
      expect(
        sqliteJson<{ n: number }>(dbPath, 'SELECT COUNT(*) AS n FROM authority_totals')[0]?.n,
      ).toBe(1);
      expect(
        sqliteJson<{ n: number }>(
          dbPath,
          "SELECT COUNT(*) AS n FROM search_index WHERE kind = 'contract' AND ref GLOB 'c:[eo]:*'",
        )[0]?.n,
      ).toBe(firstContracts.length + 1);
      expect(sqlite(dbPath, 'PRAGMA foreign_key_check;').trim()).toBe('');

      readScript(dbPath, refreshSlicePath);

      const secondContracts = sqliteJson<{ id: string; amount_eur: number }>(
        dbPath,
        "SELECT id, amount_eur FROM contracts WHERE id GLOB 'c:e:*' ORDER BY id",
      );
      expect(secondContracts).toEqual(firstContracts);
      resetRawStaging(dbPath);
      seedRepeatedAnnexOnly(dbPath);
      readScript(dbPath, refreshSlicePath);
      expect(
        sqliteJson<{ n: number }>(
          dbPath,
          "SELECT COUNT(*) AS n FROM amendments WHERE contract_number = 'CONTRACT-CE-1'",
        )[0]?.n,
      ).toBe(1);
      expect(
        sqliteJson<{ annex_count: number; current_value: number }>(
          dbPath,
          "SELECT annex_count, current_value FROM contracts WHERE contract_number = 'CONTRACT-CE-1'",
        )[0],
      ).toEqual({ annex_count: 1, current_value: 1200 });
      expect(sqlite(dbPath, 'PRAGMA foreign_key_check;').trim()).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not insert an OCDS duplicate after an existing EOP contract', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-refresh-slice-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      readScript(dbPath, schemaPath);
      readScript(dbPath, migration1Path);
      readScript(dbPath, migration2Path);
      readScript(dbPath, workStagingSchemaPath);
      seedEopOnlySharedNumber(dbPath);
      readScript(dbPath, refreshSlicePath);

      resetRawStaging(dbPath);
      seedOcdsOnlySharedNumber(dbPath);
      readScript(dbPath, refreshSlicePath);

      expect(
        sqliteJson<{ n: number }>(
          dbPath,
          "SELECT COUNT(*) AS n FROM contracts WHERE contract_number = 'CONTRACT-SHARED'",
        )[0]?.n,
      ).toBe(1);
      expect(
        sqliteJson<{ n: number }>(
          dbPath,
          "SELECT COUNT(*) AS n FROM contracts WHERE contract_number = 'CONTRACT-SHARED' AND id GLOB 'c:o:*'",
        )[0]?.n,
      ).toBe(0);
      expect(
        sqliteJson<{ n: number }>(
          dbPath,
          `SELECT COUNT(*) AS n
           FROM (
             SELECT contract_number
             FROM contracts
             GROUP BY contract_number
             HAVING SUM(id GLOB 'c:e:*') > 0 AND SUM(id GLOB 'c:o:*') > 0
           )`,
        )[0]?.n,
      ).toBe(0);
      expect(
        sqliteJson<{ total: number }>(
          dbPath,
          "SELECT ROUND(SUM(amount_eur), 2) AS total FROM contracts WHERE contract_number = 'CONTRACT-SHARED'",
        )[0]?.total,
      ).toBeCloseTo(1000 / 1.95583, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recomputes value_flag from amendment rollup instead of keeping stale flags', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-refresh-slice-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      readScript(dbPath, schemaPath);
      readScript(dbPath, migration1Path);
      readScript(dbPath, migration2Path);
      readScript(dbPath, workStagingSchemaPath);
      sqlite(
        dbPath,
        `INSERT INTO authorities (id, name, bulstat, type) VALUES ('auth:323456788', 'Authority Flag', '323456788', 'public');
         INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES ('eik:777777771', 'Bidder Flag', '777777771', '777777771', 1, 'company');
         INSERT INTO tenders (id, source_id, title, authority_id, estimated_value, currency, procedure_type, status)
           VALUES ('t:UNP-FLAG', 'UNP-FLAG', 'Flag tender', 'auth:323456788', 1000, 'BGN', 'open', 'awarded');
         INSERT INTO contracts
           (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, signing_value,
            current_value, annex_count, value_flag, amount_eur, signing_value_eur)
           VALUES
           ('c:e:flag', 't:UNP-FLAG', 'eik:777777771', 100, 'BGN', '2026-06-02',
            'CONTRACT-FLAG', 100, 10000, 1, 'annex_suspect', NULL, 100 / 1.95583);
         INSERT INTO raw_amendments
           (source, dataset_year, dataset_variant, fetched_at, seq_no, document_number,
            contract_number, contract_date, published_at, unp, authority_eik, authority_name,
            procurement_subject, contract_kind, value_before, value_after, value_delta,
            currency, description)
         VALUES
           ('eop:annexes:2026-06-02', 2026, 'eop', '2026-06-08T00:00:00Z', '2', 'AMD-FLAG-2',
            'CONTRACT-FLAG', '2026-06-02', '2026-06-03', 'UNP-FLAG', '323456788', 'Authority Flag',
            'Flag tender', 'works', 10000, 120, -9880, 'BGN', 'Normalize');`,
      );

      readScript(dbPath, refreshSlicePath);
      const row = sqliteJson<{
        value_flag: string;
        amount: number;
        amount_eur: number;
        signing_value_eur: number;
      }>(
        dbPath,
        "SELECT value_flag, amount, amount_eur, signing_value_eur FROM contracts WHERE id = 'c:e:flag'",
      )[0];
      expect(row?.value_flag).toBe('ok');
      expect(row?.amount).toBe(120);
      expect(row?.amount_eur).toBeCloseTo(120 / 1.95583, 6);
      expect(row?.signing_value_eur).toBeCloseTo(100 / 1.95583, 6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('converts current_value_eur from the amendment currency, not the contract signing currency (#245)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-refresh-slice-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      readScript(dbPath, schemaPath);
      readScript(dbPath, migration1Path);
      readScript(dbPath, migration2Path);
      readScript(dbPath, workStagingSchemaPath);
      sqlite(
        dbPath,
        `INSERT INTO authorities (id, name, bulstat, type) VALUES ('auth:523456789', 'Authority Eur', '523456789', 'public');
         INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES ('eik:877777777', 'Bidder Eur', '877777777', '877777777', 1, 'company');
         INSERT INTO tenders (id, source_id, title, authority_id, estimated_value, currency, procedure_type, status)
           VALUES ('t:UNP-EUR', 'UNP-EUR', 'Eur tender', 'auth:523456789', 5000, 'BGN', 'open', 'awarded');
         INSERT INTO contracts
           (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, signing_value,
            current_value, current_value_currency, annex_count, value_flag, amount_eur, signing_value_eur, current_value_eur)
           VALUES
           ('c:e:eurannex', 't:UNP-EUR', 'eik:877777777', 500, 'BGN', '2025-06-02',
            'CONTRACT-EUR', 1000, 500, 'BGN', 1, 'ok', 500 / 1.95583, 1000 / 1.95583, 500 / 1.95583);
         INSERT INTO raw_amendments
           (source, dataset_year, dataset_variant, fetched_at, seq_no, document_number,
            contract_number, contract_date, published_at, unp, authority_eik, authority_name,
            procurement_subject, contract_kind, value_before, value_after, value_delta,
            currency, description)
         VALUES
           ('eop:annexes:2026-06-02', 2026, 'eop', '2026-06-08T00:00:00Z', '2', 'AMD-EUR-2',
            'CONTRACT-EUR', '2026-06-02', '2026-06-03', 'UNP-EUR', '523456789', 'Authority Eur',
            'Eur tender', 'works', 500, 2000, 1500, 'EUR', 'Post-switch EUR annex');`,
      );

      readScript(dbPath, refreshSlicePath);
      const row = sqliteJson<{
        value_flag: string;
        current_value: number;
        current_value_currency: string;
        amount_eur: number;
        current_value_eur: number;
        signing_value_eur: number;
      }>(
        dbPath,
        `SELECT value_flag, current_value, current_value_currency, amount_eur, current_value_eur, signing_value_eur
         FROM contracts WHERE id = 'c:e:eurannex'`,
      )[0];
      expect(row?.value_flag).toBe('ok');
      expect(row?.current_value).toBe(2000);
      expect(row?.current_value_currency).toBe('EUR');
      // The amendment's own EUR value, unconverted — NOT divided by the BGN peg a second time.
      expect(row?.amount_eur).toBeCloseTo(2000, 6);
      expect(row?.current_value_eur).toBeCloseTo(2000, 6);
      expect(
        sqliteJson<{ won_eur: number }>(
          dbPath,
          "SELECT won_eur FROM company_totals WHERE bidder_id = 'eik:877777777'",
        )[0]?.won_eur,
      ).toBeCloseTo(2000, 6);
      // signing_value stays denominated in the contract's own (BGN) signing currency — unaffected.
      expect(row?.signing_value_eur).toBeCloseTo(1000 / 1.95583, 6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes amount_eur and full rollups from a non-BGN amendment currency', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-normalize-currency-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      initWorkDb(dbPath);
      seedCrossCurrencyAmendment(dbPath);
      readScript(dbPath, deriveAmendmentsPath);
      readScript(dbPath, normalizePath);
      readScript(dbPath, promoteAmendmentsPath);
      readScript(dbPath, precomputePath);

      const expected = 104748559.44;
      const contract = sqliteJson<{
        value_flag: string;
        current_value_currency: string;
        amount_eur: number;
        current_value_eur: number;
      }>(
        dbPath,
        `SELECT value_flag, current_value_currency, amount_eur, current_value_eur
         FROM contracts WHERE contract_number = 'CONTRACT-CROSS-CURRENCY'`,
      )[0];
      expect(contract?.value_flag).toBe('ok');
      expect(contract?.current_value_currency).toBe('EUR');
      expect(contract?.amount_eur).toBeCloseTo(expected, 2);
      expect(contract?.current_value_eur).toBeCloseTo(expected, 2);

      for (const [table, column] of [
        ['company_totals', 'won_eur'],
        ['authority_totals', 'spent_eur'],
        ['sector_totals', 'value_eur'],
        ['home_totals', 'value_eur'],
        ['flow_pairs', 'won_eur'],
      ] as const) {
        expect(
          sqliteJson<{ total: number }>(dbPath, `SELECT ${column} AS total FROM ${table}`)[0]
            ?.total,
          `${table}.${column}`,
        ).toBeCloseTo(expected, 2);
      }
      expect(
        sqliteJson<{ amount: number }>(
          dbPath,
          "SELECT amount FROM search_index WHERE kind = 'contract'",
        )[0]?.amount,
      ).toBeCloseTo(expected, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies cross-currency amendments identically in full and slice derives', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-currency-flag-parity-'));
    const fullDb = resolve(dir, 'full.sqlite');
    const sliceDb = resolve(dir, 'slice.sqlite');
    try {
      for (const dbPath of [fullDb, sliceDb]) {
        initWorkDb(dbPath);
        seedCrossCurrencyFlagBoundary(dbPath);
        readScript(dbPath, deriveAmendmentsPath);
      }
      readScript(fullDb, normalizePath);
      readScript(sliceDb, refreshSlicePath);

      const valueSql = `SELECT value_flag, ROUND(amount_eur, 2) AS amount_eur
        FROM contracts WHERE contract_number = 'CONTRACT-FX-FLAG'`;
      expect(sqliteJson(fullDb, valueSql)).toEqual([{ value_flag: 'review', amount_eur: 20000 }]);
      expect(sqliteJson(sliceDb, valueSql)).toEqual(sqliteJson(fullDb, valueSql));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies amendment rollups from the contract-row estimated value', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-refresh-slice-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      readScript(dbPath, schemaPath);
      readScript(dbPath, migration1Path);
      readScript(dbPath, migration2Path);
      readScript(dbPath, workStagingSchemaPath);
      sqlite(
        dbPath,
        `INSERT INTO raw_tenders
          (source, dataset_year, fetched_at, unp, tender_id, procedure_type, procurement_subject,
           cpv_code, cpv_description, contract_kind, estimated_value, currency, legal_basis,
           award_criteria, authority_name, authority_eik, authority_type, main_activity, deadline,
           notice_type, lot_id, lot_name, num_lots, eu_funded, published_at)
        VALUES
          ('eop:tenders:2026-06-01', 2026, '2026-06-07T00:00:00Z', 'UNP-MISMATCH', 'TENDER-MISMATCH',
           'open', 'Mismatch tender', '45000000', 'Construction', 'works', 500000, 'BGN', 'basis',
           'lowest', 'Authority Mismatch', '423456789', 'public', 'activity', '2026-06-10', 'notice',
           NULL, NULL, 1, 0, '2026-06-01');

        INSERT INTO raw_contracts
          (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
           published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
           cpv_description, contract_kind, estimated_value, procurement_currency, legal_basis,
           award_criteria, authority_name, authority_eik, authority_type, main_activity, notice_type,
           lot_id, contract_number, contract_date, signing_value, currency, contract_subject,
           awarded_to_group, contractor_eik, contractor_name, contractor_country, winner_size,
           eu_funded, bids_received, bids_sme, bids_rejected, bids_non_eea, duration_days)
        VALUES
          ('eop:contracts:2026-06-01', 2026, 'eop', '2026-06-07T00:00:00Z', 0, 'DOC-MISMATCH',
           '2026-06-01', 'UNP-MISMATCH', 'TENDER-MISMATCH', 'open', 'Mismatch tender', '45000000',
           'Construction', 'works', 1000, 'BGN', 'basis', 'lowest', 'Authority Mismatch', '423456789',
           'public', 'activity', 'notice', NULL, 'CONTRACT-MISMATCH', '2026-06-02', 1000, 'BGN',
           'Mismatch contract', 0, '677777779', 'Bidder Mismatch', 'BG', 'small', 0, 3, 1, 0, 0, 30);

        INSERT INTO raw_amendments
          (source, dataset_year, dataset_variant, fetched_at, seq_no, document_number,
           contract_number, contract_date, published_at, unp, authority_eik, authority_name,
           procurement_subject, contract_kind, value_before, value_after, value_delta,
           currency, description)
        VALUES
          ('eop:annexes:2026-06-01', 2026, 'eop', '2026-06-07T00:00:00Z', '1', 'AMD-MISMATCH',
           'CONTRACT-MISMATCH', '2026-06-02', '2026-06-03', 'UNP-MISMATCH', '423456789', 'Authority Mismatch',
           'Mismatch tender', 'works', 1000, 500000, 499000, 'EUR', 'Huge increase');`,
      );

      readScript(dbPath, refreshSlicePath);
      const row = sqliteJson<{
        value_flag: string;
        amount: number;
        amount_eur: number | null;
        current_value_currency: string;
        signing_value_eur: number | null;
      }>(
        dbPath,
        "SELECT value_flag, amount, amount_eur, current_value_currency, signing_value_eur FROM contracts WHERE contract_number = 'CONTRACT-MISMATCH'",
      )[0];
      expect(row?.value_flag).toBe('annex_suspect');
      expect(row?.amount).toBe(1000);
      expect(row?.current_value_currency).toBe('EUR');
      // The suspect EUR amendment is rejected, so the selected signing_value still converts as BGN.
      expect(row?.amount_eur).toBeCloseTo(1000 / 1.95583, 6);
      expect(row?.signing_value_eur).toBeCloseTo(1000 / 1.95583, 6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('matches full normalize contract ids for the same staging rows', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-refresh-slice-'));
    const fullDb = resolve(dir, 'full.sqlite');
    const sliceDb = resolve(dir, 'slice.sqlite');
    try {
      initWorkDb(fullDb);
      initWorkDb(sliceDb);
      seedContractIdFixture(fullDb);
      seedContractIdFixture(sliceDb);

      readScript(fullDb, normalizePath);
      readScript(sliceDb, refreshSlicePath);

      const fullRows = sqliteJson<{
        id: string;
        contract_number: string | null;
        tender_id: string;
        bidder_id: string;
        amount_eur: number;
      }>(
        fullDb,
        `SELECT id, contract_number, tender_id, bidder_id, ROUND(amount_eur, 6) AS amount_eur
         FROM contracts ORDER BY id`,
      );
      const sliceRows = sqliteJson<{
        id: string;
        contract_number: string | null;
        tender_id: string;
        bidder_id: string;
        amount_eur: number;
      }>(
        sliceDb,
        `SELECT id, contract_number, tender_id, bidder_id, ROUND(amount_eur, 6) AS amount_eur
         FROM contracts ORDER BY id`,
      );
      expect(sliceRows).toEqual(fullRows);
      expect(sliceRows.some((row) => row.contract_number === null && row.id.includes('::'))).toBe(
        true,
      );
      expect(sliceRows.every((row) => row.id !== null && row.id.length > 0)).toBe(true);
      expect(sliceRows.filter((row) => row.contract_number === 'CONTRACT-ID')).toHaveLength(1);
      expect(
        sliceRows.some((row) => row.id.startsWith('c:o:') && row.contract_number === 'CONTRACT-ID'),
      ).toBe(false);
      expect(sqlite(sliceDb, 'PRAGMA foreign_key_check;').trim()).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps contract ids stable across post-amendment and pre-amendment staging', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-refresh-slice-'));
    const fullDb = resolve(dir, 'full.sqlite');
    const sliceDb = resolve(dir, 'slice.sqlite');
    try {
      initWorkDb(fullDb);
      initWorkDb(sliceDb);
      for (const dbPath of [fullDb, sliceDb]) {
        sqlite(
          dbPath,
          `INSERT INTO raw_tenders
            (source, dataset_year, fetched_at, unp, tender_id, procedure_type, procurement_subject,
             cpv_code, cpv_description, contract_kind, estimated_value, currency, legal_basis,
             award_criteria, authority_name, authority_eik, authority_type, main_activity, deadline,
             notice_type, lot_id, lot_name, num_lots, eu_funded, published_at)
          VALUES
            ('eop:tenders:2026-06-01', 2026, '2026-06-07T00:00:00Z', 'UNP-ORD', 'TENDER-ORD',
             'open', 'Ordinal tender', '45000000', 'Construction', 'works', 10000, 'BGN', 'basis',
             'lowest', 'Authority Ordinal', '723456781', 'public', 'activity', '2026-06-10', 'notice',
             NULL, NULL, 1, 0, '2026-06-01');

          INSERT INTO raw_amendments
            (source, dataset_year, dataset_variant, fetched_at, seq_no, document_number,
             contract_number, contract_date, published_at, unp, authority_eik, authority_name,
             procurement_subject, contract_kind, value_before, value_after, value_delta,
             currency, description)
          VALUES
            ('eop:annexes:2026-06-01', 2026, 'eop', '2026-06-07T00:00:00Z', '1', 'AMD-ORD',
             'CONTRACT-ORD', '2026-06-02', '2026-06-03', 'UNP-ORD', '723456781', 'Authority Ordinal',
             'Ordinal tender', 'works', 100, 150, 50, 'BGN', 'Increase');`,
        );
      }
      sqlite(
        fullDb,
        `INSERT INTO raw_contracts
          (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
           published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
           cpv_description, contract_kind, estimated_value, procurement_currency, legal_basis,
           award_criteria, authority_name, authority_eik, authority_type, main_activity, notice_type,
           lot_id, contract_number, contract_date, signing_value, current_value, annex_count, currency, contract_subject,
           awarded_to_group, contractor_eik, contractor_name, contractor_country, winner_size,
           eu_funded, bids_received, bids_sme, bids_rejected, bids_non_eea, duration_days)
        VALUES
          ('eop:contracts:2026-06-01', 2026, 'eop', '2026-06-07T00:00:00Z', 0, 'DOC-A',
           '2026-06-01', 'UNP-ORD', 'TENDER-ORD', 'open', 'Ordinal tender', '45000000',
           'Construction', 'works', 10000, 'BGN', 'basis', 'lowest', 'Authority Ordinal', '723456781',
           'public', 'activity', 'notice', NULL, 'CONTRACT-ORD', '2026-06-02', 100, 150, 1, 'BGN',
           'Ordinal A', 0, '777777771', 'Bidder Ordinal', 'BG', 'small', 0, 1, 1, 0, 0, 30),
          ('eop:contracts:2026-06-01', 2026, 'eop', '2026-06-07T00:00:00Z', 0, 'DOC-B',
           '2026-06-01', 'UNP-ORD', 'TENDER-ORD', 'open', 'Ordinal tender', '45000000',
           'Construction', 'works', 10000, 'BGN', 'basis', 'lowest', 'Authority Ordinal', '723456781',
           'public', 'activity', 'notice', NULL, 'CONTRACT-ORD', '2026-06-02', 100, 150, 1, 'BGN',
           'Ordinal B', 0, '777777771', 'Bidder Ordinal', 'BG', 'small', 0, 1, 1, 0, 0, 30);`,
      );
      sqlite(
        sliceDb,
        `INSERT INTO raw_contracts
          (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
           published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
           cpv_description, contract_kind, estimated_value, procurement_currency, legal_basis,
           award_criteria, authority_name, authority_eik, authority_type, main_activity, notice_type,
           lot_id, contract_number, contract_date, signing_value, current_value, annex_count, currency, contract_subject,
           awarded_to_group, contractor_eik, contractor_name, contractor_country, winner_size,
           eu_funded, bids_received, bids_sme, bids_rejected, bids_non_eea, duration_days)
        VALUES
          ('eop:contracts:2026-06-01', 2026, 'eop', '2026-06-07T00:00:00Z', 0, 'DOC-A',
           '2026-06-01', 'UNP-ORD', 'TENDER-ORD', 'open', 'Ordinal tender', '45000000',
           'Construction', 'works', 10000, 'BGN', 'basis', 'lowest', 'Authority Ordinal', '723456781',
           'public', 'activity', 'notice', NULL, 'CONTRACT-ORD', '2026-06-02', 100, NULL, 0, 'BGN',
           'Ordinal A', 0, '777777771', 'Bidder Ordinal', 'BG', 'small', 0, 1, 1, 0, 0, 30),
          ('eop:contracts:2026-06-01', 2026, 'eop', '2026-06-07T00:00:00Z', 0, 'DOC-B',
           '2026-06-01', 'UNP-ORD', 'TENDER-ORD', 'open', 'Ordinal tender', '45000000',
           'Construction', 'works', 10000, 'BGN', 'basis', 'lowest', 'Authority Ordinal', '723456781',
           'public', 'activity', 'notice', NULL, 'CONTRACT-ORD', '2026-06-02', 100, NULL, 0, 'BGN',
           'Ordinal B', 0, '777777771', 'Bidder Ordinal', 'BG', 'small', 0, 1, 1, 0, 0, 30);`,
      );

      readScript(fullDb, normalizePath);
      readScript(sliceDb, refreshSlicePath);

      expect(sqliteJson<{ id: string }>(fullDb, 'SELECT id FROM contracts ORDER BY id')).toEqual(
        sqliteJson<{ id: string }>(sliceDb, 'SELECT id FROM contracts ORDER BY id'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('folds synthetic tender values monotonically across windows', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-refresh-slice-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      initWorkDb(dbPath);
      seedSyntheticAuthority(dbPath);
      seedSyntheticWindow(dbPath, {
        unp: 'UNP-SYN',
        source: 'eop:contracts:2026-06-01',
        subject: 'Real subject',
        cpv: '50000000',
        estimated: 500,
        currency: 'EUR',
      });
      readScript(dbPath, refreshSlicePath);

      resetRawStaging(dbPath);
      seedSyntheticAuthority(dbPath);
      seedSyntheticWindow(dbPath, {
        unp: 'UNP-SYN',
        source: 'eop:contracts:2026-06-02',
        subject: null,
        cpv: '30000000',
        estimated: 300,
        currency: null,
      });
      readScript(dbPath, refreshSlicePath);

      expect(
        sqliteJson<{
          title: string;
          cpv_code: string;
          estimated_value: number;
          currency: string;
        }>(
          dbPath,
          "SELECT title, cpv_code, estimated_value, currency FROM tenders WHERE id = 't:UNP-SYN'",
        )[0],
      ).toEqual({
        title: 'Real subject',
        cpv_code: '30000000',
        estimated_value: 300,
        currency: 'EUR',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the raw EOP tenderId on real and synthetic tenders', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-refresh-slice-'));
    const realDb = resolve(dir, 'real.sqlite');
    const synDb = resolve(dir, 'syn.sqlite');
    try {
      // Real tender — the EOP id is the header row's tender_id (raw_tenders.tender_id).
      initWorkDb(realDb);
      seedEopBaseDay(realDb);
      readScript(realDb, normalizePath);
      expect(
        sqliteJson<{ eop_tender_id: string | null }>(
          realDb,
          "SELECT eop_tender_id FROM tenders WHERE source_id = 'UNP-CE-1'",
        )[0],
      ).toEqual({ eop_tender_id: 'TENDER-CE-1' });

      // Synthetic tender — no header, so the EOP id is folded from the contract feed (tender_ext_id).
      initWorkDb(synDb);
      seedSyntheticAuthority(synDb);
      seedSyntheticWindow(synDb, {
        unp: 'UNP-SYN',
        source: 'eop:contracts:2026-06-01',
        subject: 'Synthetic',
        cpv: '50000000',
        estimated: 500,
        currency: 'EUR',
      });
      readScript(synDb, refreshSlicePath);
      expect(
        sqliteJson<{ procedure_type: string; eop_tender_id: string | null }>(
          synDb,
          "SELECT procedure_type, eop_tender_id FROM tenders WHERE id = 't:UNP-SYN'",
        )[0],
      ).toEqual({ procedure_type: 'неизвестна', eop_tender_id: 'TENDER-UNP-SYN' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not fold synthetic values over a real header with null procedure type', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-refresh-slice-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      initWorkDb(dbPath);
      sqlite(
        dbPath,
        `INSERT INTO raw_tenders
          (source, dataset_year, fetched_at, unp, tender_id, procedure_type, procurement_subject,
           cpv_code, cpv_description, contract_kind, estimated_value, currency, legal_basis,
           award_criteria, authority_name, authority_eik, authority_type, main_activity, deadline,
           notice_type, lot_id, lot_name, num_lots, eu_funded, published_at)
        VALUES
          ('eop:tenders:2026-06-01', 2026, '2026-06-07T00:00:00Z', 'UNP-REAL', 'TENDER-REAL',
           NULL, 'Real header', '99000000', 'Header', 'works', 990, 'EUR', 'basis',
           'lowest', 'Authority Synthetic', '623456780', 'public', 'activity', '2026-06-10', 'notice',
           NULL, NULL, 1, 0, '2026-06-01');`,
      );
      seedSyntheticWindow(dbPath, {
        unp: 'UNP-REAL',
        source: 'eop:contracts:2026-06-01',
        subject: 'Contract subject',
        cpv: '11000000',
        estimated: 110,
        currency: 'BGN',
      });

      readScript(dbPath, refreshSlicePath);

      expect(
        sqliteJson<{ cpv_code: string; estimated_value: number; currency: string }>(
          dbPath,
          "SELECT cpv_code, estimated_value, currency FROM tenders WHERE id = 't:UNP-REAL'",
        )[0],
      ).toEqual({ cpv_code: '99000000', estimated_value: 990, currency: 'EUR' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replays served parties so later-born entities match full normalize enrichment', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-refresh-slice-'));
    const fullDb = resolve(dir, 'full.sqlite');
    const sliceDb = resolve(dir, 'slice.sqlite');
    try {
      initWorkDb(fullDb);
      initWorkDb(sliceDb);

      seedReplayParty(fullDb);
      seedReplayEntity(fullDb);
      readScript(fullDb, normalizePath);

      seedReplayParty(sliceDb);
      readScript(sliceDb, refreshSlicePath);
      const partiesAfterWindow1 = sqliteJson<{
        party_key: string;
        eik: string | null;
        source: string;
      }>(sliceDb, 'SELECT party_key, eik, source FROM parties ORDER BY party_key');
      expect(partiesAfterWindow1.length).toBe(2);

      resetRawStaging(sliceDb);
      seedReplayEntity(sliceDb);
      readScript(sliceDb, refreshSlicePath);

      const authoritySql =
        "SELECT id, nuts, settlement, address, contact_email, contact_phone FROM authorities WHERE id='auth:823456782'";
      const bidderSql =
        "SELECT id, nuts, settlement, address, contact_email, contact_phone FROM bidders WHERE id='eik:823456782'";
      const fullAuthorities = sqliteJson(fullDb, authoritySql);
      const sliceAuthorities = sqliteJson(sliceDb, authoritySql);
      const fullBidders = sqliteJson(fullDb, bidderSql);
      const sliceBidders = sqliteJson(sliceDb, bidderSql);
      expect(fullAuthorities).not.toHaveLength(0);
      expect(sliceAuthorities).toEqual(fullAuthorities);
      expect(fullBidders).not.toHaveLength(0);
      expect(sliceBidders).toEqual(fullBidders);

      const partiesAfterWindow2 = sqliteJson(sliceDb, 'SELECT * FROM parties ORDER BY party_key');
      const authorityAfterWindow2 = sqliteJson(sliceDb, authoritySql);
      const bidderAfterWindow2 = sqliteJson(sliceDb, bidderSql);

      readScript(sliceDb, refreshSlicePath);
      expect(sqliteJson(sliceDb, 'SELECT * FROM parties ORDER BY party_key')).toEqual(
        partiesAfterWindow2,
      );
      expect(sqliteJson(sliceDb, authoritySql)).toEqual(authorityAfterWindow2);
      expect(sqliteJson(sliceDb, bidderSql)).toEqual(bidderAfterWindow2);
      expect(sqlite(sliceDb, 'PRAGMA foreign_key_check;').trim()).toBe('');

      dropRawStaging(sliceDb);
      expect(
        sqliteJson<{ n: number }>(
          sliceDb,
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'raw_%'",
        )[0]?.n,
      ).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps distinct EIKs that share an OCDS positional party slot, in both paths', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-refresh-slice-'));
    const fullDb = resolve(dir, 'full.sqlite');
    const sliceDb = resolve(dir, 'slice.sqlite');
    try {
      const partyByEik =
        "SELECT eik, locality, street_address, contact_email FROM parties WHERE eik IN ('111111113','222222226') ORDER BY eik";
      const bidderByEik =
        "SELECT eik_normalized AS eik, settlement, address, contact_email FROM bidders WHERE eik_normalized IN ('111111113','222222226') ORDER BY eik_normalized";
      // Each company must be enriched from its OWN party row, not the latest slot occupant's.
      const expectedParties = [
        {
          eik: '111111113',
          locality: 'City A',
          street_address: 'Addr A 1',
          contact_email: 'a@example.test',
        },
        {
          eik: '222222226',
          locality: 'City B',
          street_address: 'Addr B 2',
          contact_email: 'b@example.test',
        },
      ];
      const expectedBidders = [
        {
          eik: '111111113',
          settlement: 'City A',
          address: 'Addr A 1',
          contact_email: 'a@example.test',
        },
        {
          eik: '222222226',
          settlement: 'City B',
          address: 'Addr B 2',
          contact_email: 'b@example.test',
        },
      ];

      for (const [db, script] of [
        [fullDb, normalizePath],
        [sliceDb, refreshSlicePath],
      ] as const) {
        initWorkDb(db);
        seedTwoCollidingBidders(db);
        seedCollidingPartySlot(db);
        readScript(db, script);
        // Both companies survive the projection (old positional key dropped the earlier one).
        expect(sqliteJson(db, partyByEik)).toEqual(expectedParties);
        // …and each bidder is enriched from its own data, never cross-contaminated.
        expect(sqliteJson(db, bidderByEik)).toEqual(expectedBidders);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Same contract_number+unp+lot, two windows. The bidder regression changes the contractor while
// holding authority constant; the authority regression promotes the same synthetic tender to a real
// header with a different authority.
function seedReattrContract(
  dbPath: string,
  source: string,
  eik: string,
  name: string,
  authorityEik = '923456783',
  authorityName = 'Reattr authority',
): void {
  sqlite(
    dbPath,
    `INSERT INTO raw_contracts
      (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
       published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
       cpv_description, contract_kind, estimated_value, procurement_currency, legal_basis,
       award_criteria, authority_name, authority_eik, authority_type, main_activity, notice_type,
       lot_id, contract_number, contract_date, signing_value, currency, contract_subject,
       awarded_to_group, contractor_eik, contractor_name, contractor_country, winner_size,
       eu_funded, bids_received, bids_sme, bids_rejected, bids_non_eea, duration_days)
    VALUES
      (${sqlValue(source)}, 2026, 'eop', '2026-06-08T00:00:00Z', 0, 'DOC-REATTR',
       '2026-06-02', 'UNP-REATTR', 'TENDER-REATTR', 'open', 'Reattr tender', '45000000',
       'Construction', 'works', 1000, 'BGN', 'basis', 'lowest', ${sqlValue(authorityName)},
       ${sqlValue(authorityEik)}, 'public', 'activity', 'notice', '1', 'CONTRACT-REATTR',
       '2026-06-02', 100, 'BGN',
       'Reattr contract', 0, ${sqlValue(eik)}, ${sqlValue(name)}, 'BG', 'small', 0, 1, 1, 0, 0, 30);`,
  );
}

function seedReattrTender(
  dbPath: string,
  source: string,
  authorityEik: string,
  authorityName: string,
): void {
  sqlite(
    dbPath,
    `INSERT INTO raw_tenders
      (source, dataset_year, fetched_at, unp, tender_id, procedure_type, procurement_subject,
       cpv_code, cpv_description, contract_kind, estimated_value, currency, legal_basis,
       award_criteria, authority_name, authority_eik, authority_type, main_activity, deadline,
       notice_type, lot_id, lot_name, num_lots, eu_funded, published_at)
    VALUES
      (${sqlValue(source)}, 2026, '2026-06-11T00:00:00Z', 'UNP-REATTR', 'TENDER-REATTR',
       'open', 'Reattr tender', '45000000', 'Construction', 'works', 1000, 'BGN', 'basis',
       'lowest', ${sqlValue(authorityName)}, ${sqlValue(authorityEik)}, 'public', 'activity',
       '2026-06-10', 'notice', NULL, NULL, 1, 0, '2026-06-05');`,
  );
}

describe('refresh-slice integrity gate', () => {
  // The slice path rebuilds authority_totals/company_totals scoped to the touched entity set, then the
  // import calls assertIntegrity. The headline rollup reconciliation holds only if the touched set
  // includes the OLD entity on re-attribution — otherwise the old rollup row goes stale and the gate
  // would exit 1 on the daily refresh. refresh-slice captures the old bidder/authority BEFORE the
  // delete and the new one AFTER the insert; this regression test locks that in.
  it('stays green after a bidder re-attribution (old + new rollups both rebuilt)', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-slice-gate-'));
    const dbPath = resolve(dir, 'test.sqlite');
    const run = (sql: string) => sqliteJson<Record<string, unknown>>(dbPath, sql);
    const wonEur = (eik: string) =>
      sqliteJson<{ won_eur: number }>(
        dbPath,
        `SELECT won_eur FROM company_totals WHERE bidder_id = 'eik:${eik}'`,
      )[0]?.won_eur ?? 0;
    try {
      initWorkDb(dbPath);
      // window 1: contract attributed to bidder A
      seedReattrContract(dbPath, 'eop:contracts:2026-06-02', '111111113', 'Company A');
      readScript(dbPath, refreshSlicePath);
      expect(wonEur('111111113')).toBeGreaterThan(0);

      // window 2: same contract_number+unp re-imported with a different contractor → re-attribution
      resetRawStaging(dbPath);
      seedReattrContract(dbPath, 'eop:contracts:2026-06-05', '222222226', 'Company B');
      readScript(dbPath, refreshSlicePath);

      // A's scoped rollup was rebuilt to empty (the value moved), B now carries it…
      expect(wonEur('111111113')).toBe(0);
      expect(wonEur('222222226')).toBeGreaterThan(0);

      // …so the gate reconciles on the slice-built DB (rollup check runs; staging self-skips here).
      const results = await assertIntegrity(run, { label: 'test-slice', exit: false });
      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.find((r) => r.name === 'rollup-reconciliation')?.skipped).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays green after a tender authority re-attribution (old + new rollups both rebuilt)', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-slice-authority-gate-'));
    const dbPath = resolve(dir, 'test.sqlite');
    const run = (sql: string) => sqliteJson<Record<string, unknown>>(dbPath, sql);
    const spentEur = (eik: string) =>
      sqliteJson<{ spent_eur: number }>(
        dbPath,
        `SELECT spent_eur FROM authority_totals WHERE authority_id = 'auth:${eik}'`,
      )[0]?.spent_eur ?? 0;
    try {
      initWorkDb(dbPath);
      // window 1: a contract-derived synthetic tender attributed to authority A
      seedReattrContract(
        dbPath,
        'eop:contracts:2026-06-02',
        '111111111',
        'Company A',
        '333333333',
        'Authority A',
      );
      readScript(dbPath, refreshSlicePath);
      expect(spentEur('333333333')).toBeGreaterThan(0);

      // window 2: the real tender header promotes the same UNP under authority B
      resetRawStaging(dbPath);
      seedReattrTender(dbPath, 'eop:tenders:2026-06-05', '444444444', 'Authority B');
      seedReattrContract(
        dbPath,
        'eop:contracts:2026-06-05',
        '111111111',
        'Company A',
        '444444444',
        'Authority B',
      );
      readScript(dbPath, refreshSlicePath);

      expect(spentEur('333333333')).toBe(0);
      expect(spentEur('444444444')).toBeGreaterThan(0);

      const results = await assertIntegrity(run, { label: 'test-slice-authority', exit: false });
      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.find((r) => r.name === 'rollup-reconciliation')?.skipped).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
