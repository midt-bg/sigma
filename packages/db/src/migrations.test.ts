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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
