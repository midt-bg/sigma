/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const apiDir = resolve(root, 'apps/web');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', ['-bail', dbPath], { input: sql, encoding: 'utf8' });
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
}

function d1Json<T>(persistTo: string, sql: string): T[] {
  const out = execFileSync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      'sigma',
      '--local',
      '--persist-to',
      persistTo,
      '--json',
      '--command',
      sql,
    ],
    { cwd: apiDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).trim();
  return (JSON.parse(out)[0]?.results ?? []) as T[];
}

describe('ship-domain', () => {
  it('preserves multiline text values when shipping to served D1', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-ship-domain-'));
    const workDb = resolve(dir, 'work.sqlite');
    const persistTo = resolve(dir, 'served');
    try {
      readScript(workDb, resolve(root, 'packages/db/migrations/0000_init.sql'));
      sqlite(
        workDb,
        `INSERT INTO authorities (id, name, bulstat, type) VALUES ('auth:1', 'Authority line 1
Authority line 2', '1', 'public');
         INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES ('eik:200000007', 'Bidder', '200000007', '200000007', 1, 'company');
         INSERT INTO tenders (id, source_id, title, authority_id, currency, procedure_type, status) VALUES ('t:1', '1', 'Tender', 'auth:1', 'BGN', 'open', 'awarded');
         INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, contract_number, signing_value, value_flag, amount_eur) VALUES ('c:e:1', 't:1', 'eik:200000007', 10, 'BGN', 'C1', 10, 'ok', 10 / 1.95583);
         INSERT INTO amendments (id, natural_key, contract_number, unp, description, source) VALUES ('am:1:C1:A1', 'am:1:C1:A1', 'C1', '1', 'Description line 1
Description line 2', 'test');
         INSERT INTO nuts_regions (nuts3, nuts3_name, nuts2, nuts2_name, nuts1, nuts1_name)
           VALUES ('BG000', 'Region', 'BG00', 'Region 2', 'BG0', 'Region 1');
         INSERT INTO data_freshness (source, rows, refreshed_at) VALUES ('eop', 1, '2026-06-08');`,
      );

      execFileSync(
        'node',
        ['scripts/ship-domain.mjs', `--work-db=${workDb}`, `--persist-to=${persistTo}`],
        {
          cwd: root,
          stdio: 'pipe',
          maxBuffer: 128 * 1024 * 1024,
        },
      );

      expect(
        d1Json<{ name: string }>(persistTo, "SELECT name FROM authorities WHERE id='auth:1'")[0]
          ?.name,
      ).toBe('Authority line 1\nAuthority line 2');
      expect(
        d1Json<{ description: string }>(
          persistTo,
          "SELECT description FROM amendments WHERE id='am:1:C1:A1'",
        )[0]?.description,
      ).toBe('Description line 1\nDescription line 2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
