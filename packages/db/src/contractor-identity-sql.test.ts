/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const schema = readFileSync(resolve(root, 'packages/db/migrations/0000_init.sql'), 'utf8');
const migration2 = readFileSync(
  resolve(root, 'packages/db/migrations/0002_current_value_currency.sql'),
  'utf8',
);
const staging = readFileSync(resolve(root, 'scripts/work-staging-schema.sql'), 'utf8');
const normalize = readFileSync(resolve(root, 'scripts/normalize-raw.sql'), 'utf8');
const precompute = readFileSync(resolve(root, 'scripts/precompute.sql'), 'utf8');
const refresh = readFileSync(resolve(root, 'scripts/refresh-slice.sql'), 'utf8');

const seed = `
INSERT INTO raw_contracts
  (source, fetched_at, unp, contract_number, contract_date, published_at,
   authority_eik, authority_name, procurement_subject, estimated_value,
   signing_value, currency, contractor_eik, contractor_name)
VALUES
  ('eop:contracts:test', '2026-07-18T00:00:00Z', 'UNP-VALID', 'C-VALID', '2026-07-01',
   '2026-07-02', '123456786', 'Тестов възложител', 'Валиден ЕИК', 100, 100, 'EUR',
   '103267194', 'ТИПО ООД'),
  ('eop:contracts:test', '2026-07-18T00:00:00Z', 'UNP-TYPO', 'C-TYPO', '2026-07-01',
   '2026-07-02', '123456786', 'Тестов възложител', 'Грешна контролна цифра', 200, 200, 'EUR',
   '103267195', 'ТИПО ООД'),
  ('eop:contracts:test', '2026-07-18T00:00:00Z', 'UNP-EMPTY', 'C-EMPTY', '2026-07-01',
   '2026-07-02', '123456786', 'Тестов възложител', 'Празно име', 300, 300, 'EUR',
   '103267195', ''),
  ('eop:contracts:test', '2026-07-18T00:00:00Z', 'UNP-NULL', 'C-NULL', '2026-07-01',
   '2026-07-02', '123456786', 'Тестов възложител', 'Липсваща самоличност', 400, 400, 'EUR',
   NULL, NULL),
  ('eop:contracts:test', '2026-07-18T00:00:00Z', 'UNP-FOLD-1', 'C-FOLD-1', '2026-07-01',
   '2026-07-02', '123456786', 'Тестов възложител', 'Кавички и регистър 1', 10, 10, 'EUR',
   '', '„Строй Инвест" ЕООД'),
  ('eop:contracts:test', '2026-07-18T00:00:00Z', 'UNP-FOLD-2', 'C-FOLD-2', '2026-07-01',
   '2026-07-02', '123456786', 'Тестов възложител', 'Кавички и регистър 2', 10, 10, 'EUR',
   '', '"СТРОЙ ИНВЕСТ" ЕООД'),
  ('eop:contracts:test', '2026-07-18T00:00:00Z', 'UNP-FOLD-3', 'C-FOLD-3', '2026-07-01',
   '2026-07-02', '123456786', 'Тестов възложител', 'Кавички и интервали', 10, 10, 'EUR',
   '', '«строй   инвест» ЕООД'),
  ('eop:contracts:test', '2026-07-18T00:00:00Z', 'UNP-DASH-EN', 'C-DASH-EN', '2026-07-01',
   '2026-07-02', '123456786', 'Тестов възложител', 'Тире 1', 10, 10, 'EUR',
   '', '„Марица–Изток"'),
  ('eop:contracts:test', '2026-07-18T00:00:00Z', 'UNP-DASH-ASCII', 'C-DASH-ASCII', '2026-07-01',
   '2026-07-02', '123456786', 'Тестов възложител', 'Тире 2', 10, 10, 'EUR',
   '', '„Марица-Изток"'),
  ('eop:contracts:test', '2026-07-18T00:00:00Z', 'UNP-GUARD-HYPHEN', 'C-GUARD-HYPHEN', '2026-07-01',
   '2026-07-02', '123456786', 'Тестов възложител', 'Пази тирето', 10, 10, 'EUR',
   '', '„Марица-Изток"'),
  ('eop:contracts:test', '2026-07-18T00:00:00Z', 'UNP-GUARD-SPACE', 'C-GUARD-SPACE', '2026-07-01',
   '2026-07-02', '123456786', 'Тестов възложител', 'Пази интервала', 10, 10, 'EUR',
   '', '„Марица Изток"');
`;

function build(path: 'normalize' | 'refresh'): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  db.exec(migration2);
  db.exec(staging);
  db.exec(seed);
  if (path === 'normalize') {
    db.exec(normalize);
    db.exec(precompute);
  } else {
    db.exec(refresh);
  }
  return db;
}

describe.each(['normalize', 'refresh'] as const)('%s contractor identity', (path) => {
  it('preserves every eligible contract across valid, typo, empty, and NULL identities', () => {
    const db = build(path);
    try {
      const contracts = db
        .prepare('SELECT contract_number, bidder_id FROM contracts ORDER BY contract_number')
        .all() as { contract_number: string; bidder_id: string }[];

      expect(contracts).toEqual([
        { contract_number: 'C-DASH-ASCII', bidder_id: 'name:МАРИЦА-ИЗТОК' },
        { contract_number: 'C-DASH-EN', bidder_id: 'name:МАРИЦА-ИЗТОК' },
        { contract_number: 'C-EMPTY', bidder_id: 'unknown:анонимен' },
        { contract_number: 'C-FOLD-1', bidder_id: 'name:СТРОЙ ИНВЕСТ ЕООД' },
        { contract_number: 'C-FOLD-2', bidder_id: 'name:СТРОЙ ИНВЕСТ ЕООД' },
        { contract_number: 'C-FOLD-3', bidder_id: 'name:СТРОЙ ИНВЕСТ ЕООД' },
        { contract_number: 'C-GUARD-HYPHEN', bidder_id: 'name:МАРИЦА-ИЗТОК' },
        { contract_number: 'C-GUARD-SPACE', bidder_id: 'name:МАРИЦА ИЗТОК' },
        { contract_number: 'C-NULL', bidder_id: 'unknown:анонимен' },
        { contract_number: 'C-TYPO', bidder_id: 'name:ТИПО ООД' },
        { contract_number: 'C-VALID', bidder_id: 'eik:103267194' },
      ]);

      expect(
        db
          .prepare(
            `SELECT id, name, bulstat, eik_normalized, eik_valid, is_consortium, kind
             FROM bidders WHERE id = 'unknown:анонимен'`,
          )
          .get(),
      ).toEqual({
        id: 'unknown:анонимен',
        name: 'Неизвестен изпълнител',
        bulstat: null,
        eik_normalized: null,
        eik_valid: 0,
        is_consortium: 0,
        kind: 'unknown',
      });

      const sums = db
        .prepare(
          `SELECT
             (SELECT SUM(signing_value) FROM raw_contracts
              WHERE source LIKE 'eop:%' OR source LIKE 'ocds:%') AS raw_total,
             (SELECT SUM(amount_eur) FROM contracts) AS contract_total,
             (SELECT SUM(won_eur) FROM company_totals) AS company_total`,
        )
        .get() as { raw_total: number; contract_total: number; company_total: number };
      expect(sums).toEqual({ raw_total: 1070, contract_total: 1070, company_total: 1070 });

      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM search_index
             WHERE kind = 'company' AND ref = 'unknown:анонимен'`,
          )
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
