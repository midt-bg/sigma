/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = resolve(root, 'packages/db/migrations');
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => resolve(migrationsDir, f));
const deriveHealth = resolve(root, 'scripts/derive-health.sql');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', ['-bail', dbPath], { input: sql, encoding: 'utf8' });
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
}

describe('derive-health.sql', () => {
  // Regression for the fresh-derive abort: a CPV division whose priced contracts sum to 0 EUR
  // (here a single amount_eur=0 contract) used to make win_share 0/0 = NULL and abort the whole
  // script on sector_concentration.win_share NOT NULL. The zero-sum division must be skipped
  // (its share is unknowable — never fabricated as 0) while every other division still lands.
  it('completes when a CPV division sums to 0 EUR and skips that division', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-derive-health-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      for (const migration of migrations) readScript(dbPath, migration);

      sqlite(
        dbPath,
        `
        INSERT INTO authorities (id, name) VALUES ('auth:1', 'Възложител 1');
        INSERT INTO bidders (id, name) VALUES ('eik:100', 'Изпълнител 1'), ('eik:200', 'Изпълнител 2');
        -- Division 30: one priced contract at exactly 0 EUR → division total 0 (the abort case).
        INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type)
          VALUES ('t:1', 'unp-1', 'Тръжна 30', 'auth:1', '30200000', 'Открита процедура');
        INSERT INTO contracts (id, tender_id, bidder_id, amount, amount_eur)
          VALUES ('c:1', 't:1', 'eik:100', 0, 0);
        -- Division 45: a normal priced division that must still be rolled up.
        INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type)
          VALUES ('t:2', 'unp-2', 'Тръжна 45', 'auth:1', '45200000', 'Открита процедура');
        INSERT INTO contracts (id, tender_id, bidder_id, amount, amount_eur)
          VALUES ('c:2', 't:2', 'eik:200', 1000, 511.29);
        `,
      );

      // Must not throw: before the HAVING guard this aborted with
      // "NOT NULL constraint failed: sector_concentration.win_share".
      readScript(dbPath, deriveHealth);

      // The zero-sum division is absent — no fabricated 0 (or NULL) win_share row.
      expect(
        sqlite(dbPath, "SELECT COUNT(*) FROM sector_concentration WHERE cpv_division='30';").trim(),
      ).toBe('0');
      // The healthy division still gets its rollup, with a real share.
      expect(
        sqlite(
          dbPath,
          "SELECT COUNT(*) FROM sector_concentration WHERE cpv_division='45' AND win_share=1.0;",
        ).trim(),
      ).toBe('1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
