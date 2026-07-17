/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const schemaPath = resolve(root, 'packages/db/migrations/0000_init.sql');
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
    const bidderEik = '400000001';

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
