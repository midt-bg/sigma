/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = resolve(root, 'packages/db/migrations');
// The FULL chain in apply order — exactly what `wrangler d1 migrations apply` runs on a fresh D1
// and what scripts/import.mjs applies to a fresh work DB. Every migration must apply cleanly after
// the ones before it (e.g. 0003's ADD COLUMNs must not duplicate columns already in 0000).
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => resolve(migrationsDir, f));

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
      expect(migrations.length).toBeGreaterThanOrEqual(3);
      for (const migration of migrations) readScript(dbPath, migration);

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

      // 0003 adds the health-index foundation columns (contract quality spec §7.1) — additive
      // ALTERs only, deliberately NOT folded into 0000 (SQLite has no ADD COLUMN IF NOT EXISTS,
      // so duplicating them there would break the fresh-DB chain apply this test exercises).
      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM pragma_table_info('contracts') WHERE name IN ('exemption_legal_basis','outside_zop','dps_contract');",
        ).trim(),
      ).toBe('3');
      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM pragma_table_info('flow_pairs') WHERE name IN ('first_date','last_date');",
        ).trim(),
      ).toBe('2');
      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM pragma_table_info('tenders') WHERE name IN ('corrections_count','estimated_value_eur');",
        ).trim(),
      ).toBe('2');
      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM pragma_table_info('amendments') WHERE name IN ('reason','circumstances');",
        ).trim(),
      ).toBe('2');
      // The health rollup tables ship in the base schema (rebuilt idempotently by the ETL derive).
      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('authority_health_rollup','contract_features','year_quality_totals');",
        ).trim(),
      ).toBe('3');

      // The served schema must never carry raw_* staging tables.
      expect(
        sqlite(dbPath, "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'raw_%';").trim(),
      ).toBe('0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
