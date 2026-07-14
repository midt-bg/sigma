/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = resolve(root, 'packages/db/migrations');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
}

describe('served migrations', () => {
  // The consolidated 0000_init carries the pre-production schema; later schema changes land as
  // numbered incremental migrations (the same order `wrangler d1 migrations apply` uses). This
  // guards that the chain applied in filename order yields the complete served schema — amendments
  // history, the OCDS parties projection, the EOP tenderId column, the anomaly-screen tables — and
  // carries no raw_* staging (that lives only in work-staging-schema.sql, applied to the work DB).
  it('builds the complete served schema from the migration chain', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-migrations-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      const migrationFiles = readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      expect(migrationFiles[0]).toBe('0000_init.sql');
      for (const file of migrationFiles) readScript(dbPath, resolve(migrationsDir, file));

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

      // The anomaly screen reads precomputed tables — shipped by the 0005_anomalies migration.
      expect(
        sqlite(dbPath, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('contract_anomalies', 'cpv_price_stats');").trim(),
      ).toBe('2');
      expect(
        sqlite(dbPath, "SELECT COUNT(*) FROM pragma_table_info('contract_anomalies') WHERE name='rank_value' AND \"notnull\"=1;").trim(),
      ).toBe('1');

      // The served schema must never carry raw_* staging tables.
      expect(
        sqlite(dbPath, "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'raw_%';").trim(),
      ).toBe('0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
