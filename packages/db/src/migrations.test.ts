/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migration0 = resolve(root, 'packages/db/migrations/0000_init.sql');
const migration1 = resolve(root, 'packages/db/migrations/0001_flow_pairs_bidder_index.sql');
const migration2 = resolve(root, 'packages/db/migrations/0002_current_value_currency.sql');
const backfill = resolve(root, 'scripts/backfill-current-value-currency.sql');
const precompute = resolve(root, 'scripts/precompute.sql');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
}

describe('served migrations', () => {
  // 0000_init remains the complete base served schema. Later migrations must be additive over that
  // base so initial setup (`wrangler d1 migrations apply`) and ETL ships keep the same table shape.
  it('builds the served schema from the migration chain', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-migrations-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      readScript(dbPath, migration0);
      readScript(dbPath, migration1);
      readScript(dbPath, migration2);

      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='amendments';",
        ).trim(),
      ).toBe('1');
      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM pragma_table_info('amendments') WHERE name='natural_key' AND \"notnull\"=1;",
        ).trim(),
      ).toBe('1');

      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='parties';",
        ).trim(),
      ).toBe('1');
      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM pragma_table_info('parties') WHERE name='party_key' AND pk=1;",
        ).trim(),
      ).toBe('1');

      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM pragma_table_info('tenders') WHERE name='eop_tender_id';",
        ).trim(),
      ).toBe('1');

      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_flow_pairs_bidder' AND tbl_name='flow_pairs';",
        ).trim(),
      ).toBe('1');

      // The served schema must never carry raw_* staging tables.
      expect(
        sqlite(dbPath, "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'raw_%';").trim(),
      ).toBe('0');

      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM pragma_table_info('contracts') WHERE name='current_value_currency';",
        ).trim(),
      ).toBe('1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('backfills cross-currency amendment amounts and their rollups', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-migration-backfill-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      readScript(dbPath, migration0);
      readScript(dbPath, migration1);
      sqlite(
        dbPath,
        `INSERT INTO authorities (id, name) VALUES ('auth:1', 'Authority');
         INSERT INTO bidders (id, name, kind) VALUES ('eik:1', 'Bidder', 'company');
         INSERT INTO tenders
           (id, source_id, title, authority_id, cpv_code, procedure_type, status)
         VALUES
           ('t:UNP-1', 'UNP-1', 'Tender', 'auth:1', '45000000', 'open', 'awarded');
         INSERT INTO contracts
           (id, tender_id, bidder_id, amount, currency, contract_number, signing_value,
            current_value, value_flag, amount_eur, current_value_eur)
         VALUES
           ('c:e:1', 't:UNP-1', 'eik:1', 104748559.44, 'BGN', 'CONTRACT-1',
            136580250, 104748559.44, 'ok', 104748559.44 / 1.95583,
            104748559.44 / 1.95583);
         INSERT INTO amendments
           (id, natural_key, contract_number, unp, value_after, currency, published_at, source)
         VALUES
           ('am:1', 'am:1', 'CONTRACT-1', 'UNP-1', 104748559.44, 'EUR',
            '2026-06-03', 'eop:annexes:2026-06-01');`,
      );
      readScript(dbPath, migration2);
      readScript(dbPath, backfill);
      readScript(dbPath, precompute);

      expect(
        sqlite(
          dbPath,
          "SELECT printf('%.2f', amount_eur) || '|' || printf('%.2f', current_value_eur) || '|' || current_value_currency FROM contracts;",
        ).trim(),
      ).toBe('104748559.44|104748559.44|EUR');
      expect(sqlite(dbPath, "SELECT printf('%.2f', value_eur) FROM home_totals;").trim()).toBe(
        '104748559.44',
      );
      expect(sqlite(dbPath, "SELECT printf('%.2f', won_eur) FROM flow_pairs;").trim()).toBe(
        '104748559.44',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
