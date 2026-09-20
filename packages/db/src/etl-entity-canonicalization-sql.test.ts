/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const schemaPath = resolve(root, 'packages/db/migrations/0000_init.sql');
const migration2Path = resolve(root, 'packages/db/migrations/0002_current_value_currency.sql');
// refresh-slice.sql's officials block reads interest_links (0003); build it so the script doesn't fail.
const migration3Path = resolve(root, 'packages/db/migrations/0003_related_persons_foundation.sql');
// …and 0006, joined by the officials block for the Trade Register evidence gate (#279, ADR-0033).
const migration9Path = resolve(root, 'packages/db/migrations/0009_interest_link_evidence.sql');
// The officials search rows read person_registry_links (0014), interest_link_observations (0015) and
// person_sources (0018).
const personMigrationPaths = [
  'packages/db/migrations/0014_person_profile.sql',
  'packages/db/migrations/0015_person_observations.sql',
  'packages/db/migrations/0018_person_entities.sql',
].map((p) => resolve(root, p));
// #305 Tier-2: served amendments gained value_restated/value_treatment (promote + refresh-slice write them).
const migration6Path = resolve(root, 'packages/db/migrations/0006_amendment_restated.sql');
const migration7Path = resolve(root, 'packages/db/migrations/0007_amendment_value_suspect.sql');
// #306 provenance columns on served `amendments` — promote/refresh-slice write contract_number_raw + link_method.
const migration8Path = resolve(root, 'packages/db/migrations/0008_amendment_provenance.sql');
const stagingPath = resolve(root, 'scripts/work-staging-schema.sql');
const etlPaths = [
  ['normalize-raw', resolve(root, 'scripts/normalize-raw.sql')],
  ['refresh-slice', resolve(root, 'scripts/refresh-slice.sql')],
] as const;

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
}

function sqliteJson<T>(dbPath: string, sql: string): T[] {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
  return out ? (JSON.parse(out) as T[]) : [];
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], {
    input: `PRAGMA foreign_keys=ON;\n.read ${path}\n`,
    stdio: 'pipe',
  });
}

function withEtlDb(label: string, run: (dbPath: string) => void): void {
  const dir = mkdtempSync(resolve(tmpdir(), `sigma-entity-canonicalization-${label}-`));
  const dbPath = resolve(dir, 'test.sqlite');
  try {
    readScript(dbPath, schemaPath);
    readScript(dbPath, migration2Path);
    readScript(dbPath, migration3Path);
    readScript(dbPath, migration9Path);
    for (const path of personMigrationPaths) readScript(dbPath, path);
    readScript(dbPath, migration6Path);
    readScript(dbPath, migration7Path);
    readScript(dbPath, migration8Path);
    readScript(dbPath, stagingPath);
    run(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('ETL entity canonicalization through real SQL scripts', () => {
  it('uses the authority-name mode and all deterministic tiebreakers in both ETL paths', () => {
    const modeEik = '000695114';
    const caseEik = '300000002';
    const lengthEik = '300000003';
    const lexicalEik = '300000004';

    for (const [label, scriptPath] of etlPaths) {
      withEtlDb(label, (dbPath) => {
        sqlite(
          dbPath,
          `INSERT INTO raw_tenders
             (source, fetched_at, unp, authority_eik, authority_name, authority_type)
           VALUES
             ('eop:tenders:mode-1', '2026-06-01T00:00:00Z', 'UNP-MODE-1', '${modeEik}',
              'БСУ Д-р Петър Берон', 'public'),
             ('eop:tenders:mode-2', '2026-06-01T00:00:00Z', 'UNP-MODE-2', '${modeEik}',
              'МИНИСТЕРСТВО НА ОБРАЗОВАНИЕТО И НАУКАТА', 'public'),
             ('eop:tenders:mode-3', '2026-06-01T00:00:00Z', 'UNP-MODE-3', '${modeEik}',
              'МИНИСТЕРСТВО НА ОБРАЗОВАНИЕТО И НАУКАТА', 'public'),
             ('eop:tenders:mode-4', '2026-06-01T00:00:00Z', 'UNP-MODE-4', '${modeEik}',
              'МИНИСТЕРСТВО НА ОБРАЗОВАНИЕТО И НАУКАТА', 'public'),
             ('eop:tenders:case-1', '2026-06-01T00:00:00Z', 'UNP-CASE-1', '${caseEik}',
              'TEST AUTHORITY', 'public'),
             ('eop:tenders:case-2', '2026-06-01T00:00:00Z', 'UNP-CASE-2', '${caseEik}',
              'Test Authority', 'public'),
             ('eop:tenders:length-1', '2026-06-01T00:00:00Z', 'UNP-LENGTH-1', '${lengthEik}',
              'Short name', 'public'),
             ('eop:tenders:length-2', '2026-06-01T00:00:00Z', 'UNP-LENGTH-2', '${lengthEik}',
              'Longer authority name', 'public'),
             ('eop:tenders:lexical-1', '2026-06-01T00:00:00Z', 'UNP-LEXICAL-1', '${lexicalEik}',
              'Alpha key', 'public'),
             ('eop:tenders:lexical-2', '2026-06-01T00:00:00Z', 'UNP-LEXICAL-2', '${lexicalEik}',
              'Bravo key', 'public');

           INSERT INTO raw_contracts
             (source, fetched_at, unp, authority_eik, authority_name, contract_number,
              contract_date, signing_value, currency, contractor_eik, contractor_name)
           VALUES
             ('eop:contracts:subunit', '2026-06-01T00:00:00Z', 'UNP-MODE-1', '${modeEik}',
              'СУ „Христо Ботев" гр. Пловдив', 'CONTRACT-SUBUNIT', '2026-06-01', 1000, 'BGN',
              '400000011', 'Subunit Bidder'),
             ('eop:contracts:case', '2026-06-01T00:00:00Z', 'UNP-MODE-2', '${modeEik}',
              'Министерство на образованието и науката', 'CONTRACT-CASE', '2026-06-01', 1000,
              'BGN', '400000012', 'Case Bidder');`,
        );

        expect(
          sqliteJson<{ name: string }>(
            dbPath,
            `SELECT MIN(authority_name) AS name FROM raw_tenders WHERE authority_eik = '${modeEik}'`,
          )[0]?.name,
        ).toBe('БСУ Д-р Петър Берон');

        readScript(dbPath, scriptPath);

        expect(
          sqliteJson<{ bulstat: string; name: string }>(
            dbPath,
            `SELECT bulstat, name FROM authorities
             WHERE bulstat IN ('${modeEik}', '${caseEik}', '${lengthEik}', '${lexicalEik}')
             ORDER BY bulstat`,
          ),
        ).toEqual([
          { bulstat: modeEik, name: 'МИНИСТЕРСТВО НА ОБРАЗОВАНИЕТО И НАУКАТА' },
          { bulstat: caseEik, name: 'Test Authority' },
          { bulstat: lengthEik, name: 'Longer authority name' },
          { bulstat: lexicalEik, name: 'Alpha key' },
        ]);

        expect(
          sqliteJson<{ contract_number: string; ordering_unit_name: string }>(
            dbPath,
            `SELECT contract_number, ordering_unit_name FROM contracts
             WHERE contract_number IN ('CONTRACT-SUBUNIT', 'CONTRACT-CASE')
             ORDER BY contract_number`,
          ),
        ).toEqual([
          {
            contract_number: 'CONTRACT-CASE',
            ordering_unit_name: 'Министерство на образованието и науката',
          },
          {
            contract_number: 'CONTRACT-SUBUNIT',
            ordering_unit_name: 'СУ „Христо Ботев" гр. Пловдив',
          },
        ]);
      });
    }
  });

  it('uses the bidder-name mode for EIK- and name-keyed bidders in both ETL paths', () => {
    const bidderEik = '400000004';

    for (const [label, scriptPath] of etlPaths) {
      withEtlDb(label, (dbPath) => {
        sqlite(
          dbPath,
          `INSERT INTO raw_contracts
             (source, fetched_at, contractor_eik, contractor_name)
           VALUES
             ('eop:contracts:bidder-1', '2026-06-01T00:00:00Z', '${bidderEik}', 'A Rare Bidder'),
             ('eop:contracts:bidder-2', '2026-06-01T00:00:00Z', '${bidderEik}', 'Modal Bidder'),
             ('eop:contracts:bidder-3', '2026-06-01T00:00:00Z', '${bidderEik}', 'Modal Bidder'),
             ('eop:contracts:bidder-4', '2026-06-01T00:00:00Z', '${bidderEik}', 'Modal Bidder'),
             ('eop:contracts:name-1', '2026-06-01T00:00:00Z', 'foreign-id', 'ACME'),
             ('eop:contracts:name-2', '2026-06-01T00:00:00Z', 'foreign-id', 'Acme');`,
        );

        readScript(dbPath, scriptPath);

        expect(
          sqliteJson<{ id: string; name: string }>(
            dbPath,
            `SELECT id, name FROM bidders
             WHERE id IN ('eik:${bidderEik}', 'name:ACME')
             ORDER BY id`,
          ),
        ).toEqual([
          { id: `eik:${bidderEik}`, name: 'Modal Bidder' },
          { id: 'name:ACME', name: 'Acme' },
        ]);
      });
    }
  });

  // A valid 13-digit ЕИК is a branch of the enterprise in its first nine digits — a forestry unit of a state
  // forestry company, a regional branch of the irrigation company. It carries the enterprise's ownership,
  // whether the enterprise is on the Agency's list or derived from the register; an unlisted private company
  // stays unmarked. Both ETL paths, the same rule.
  it('marks a branch of a public enterprise by the ownership of the enterprise in both ETL paths', () => {
    for (const [label, scriptPath] of etlPaths) {
      withEtlDb(label, (dbPath) => {
        sqlite(
          dbPath,
          `CREATE TABLE IF NOT EXISTS state_owned_eik (
             eik TEXT PRIMARY KEY,
             ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('state', 'municipal', 'mixed')),
             canonical_name TEXT NOT NULL);
           CREATE TABLE IF NOT EXISTS public_owned_eik (
             eik TEXT PRIMARY KEY,
             ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('state', 'municipal')));
           INSERT INTO state_owned_eik VALUES ('600000006', 'state', '"ТЕСТ ДЪРЖАВНО" ЕАД');
           INSERT INTO public_owned_eik VALUES ('700000007', 'municipal');
           INSERT INTO raw_contracts
             (source, fetched_at, contractor_eik, contractor_name)
           VALUES
             ('eop:contracts:hq', '2026-06-01T00:00:00Z', '600000006', 'ТЕСТ ДЪРЖАВНО ЕАД'),
             ('eop:contracts:branch', '2026-06-01T00:00:00Z', '6000000060016', 'ТЕСТ ДЪРЖАВНО ЕАД - клон Тест'),
             ('eop:contracts:municipal-branch', '2026-06-01T00:00:00Z', '7000000070018', 'ТЕСТ ОБЩИНСКО ЕООД - клон Тест'),
             ('eop:contracts:private', '2026-06-01T00:00:00Z', '400000004', 'ЧАСТНО ООД');`,
        );

        readScript(dbPath, scriptPath);

        expect(
          sqliteJson<{ id: string; ownership_kind: string | null }>(
            dbPath,
            `SELECT id, ownership_kind FROM bidders
             WHERE id IN ('eik:600000006', 'eik:6000000060016', 'eik:7000000070018', 'eik:400000004')
             ORDER BY id`,
          ),
        ).toEqual([
          { id: 'eik:400000004', ownership_kind: null },
          { id: 'eik:600000006', ownership_kind: 'state' },
          { id: 'eik:6000000060016', ownership_kind: 'state' },
          { id: 'eik:7000000070018', ownership_kind: 'municipal' },
        ]);
      });
    }
  });

  it('uses the modal type for the winning authority name and buckets from raw types', () => {
    const authorityEik = '500000001';

    for (const [label, scriptPath] of etlPaths) {
      withEtlDb(label, (dbPath) => {
        sqlite(
          dbPath,
          `INSERT INTO raw_tenders
             (source, fetched_at, unp, authority_eik, authority_name, authority_type)
           VALUES
             ('eop:tenders:type-1', '2026-06-01T00:00:00Z', 'UNP-TYPE-1', '${authorityEik}',
              'Independent authority', 'Орган на централната власт'),
             ('eop:tenders:type-2', '2026-06-01T00:00:00Z', 'UNP-TYPE-2', '${authorityEik}',
              'Independent authority', 'Орган на централната власт'),
             ('eop:tenders:type-3', '2026-06-01T00:00:00Z', 'UNP-TYPE-3', '${authorityEik}',
              'Independent authority', 'Орган на централната власт'),
             ('eop:tenders:type-4', '2026-06-01T00:00:00Z', 'UNP-TYPE-4', '${authorityEik}',
              'Independent authority', 'Публично предприятие - сектор'),
             ('eop:tenders:type-5', '2026-06-01T00:00:00Z', 'UNP-TYPE-5', '${authorityEik}',
              'A misleading label', 'Комунални услуги - вода'),
             ('eop:tenders:type-6', '2026-06-01T00:00:00Z', 'UNP-TYPE-6', '${authorityEik}',
              'A misleading label', 'Комунални услуги - вода'),
             ('eop:tenders:type-7', '2026-06-01T00:00:00Z', 'UNP-TYPE-7', '${authorityEik}',
              'A misleading label', 'Комунални услуги - вода');`,
        );

        readScript(dbPath, scriptPath);

        expect(
          sqliteJson<{ name: string; type: string; type_group: string }>(
            dbPath,
            `SELECT name, type, type_group FROM authorities WHERE bulstat = '${authorityEik}'`,
          )[0],
        ).toEqual({
          name: 'Independent authority',
          type: 'Орган на централната власт',
          type_group: 'държавна компания',
        });
      });
    }
  });
});
