/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BASE_SCHEMA } from './base-schema';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const apiDir = resolve(root, 'apps/web');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', ['-bail', dbPath], { input: sql, encoding: 'utf8' });
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
}

// Wrangler is called by its own binary, not through `pnpm exec`: pnpm writes its own lines to stdout
// (`../.. | WARN …`) whenever another workspace command touches the store, and one of those in front of
// the JSON fails the parse. That only happens when the suite runs in parallel, which is every CI run.
const wranglerBin = resolve(apiDir, 'node_modules/.bin/wrangler');

function d1Json<T>(persistTo: string, sql: string): T[] {
  const out = execFileSync(
    wranglerBin,
    ['d1', 'execute', 'sigma', '--local', '--persist-to', persistTo, '--json', '--command', sql],
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
      for (const file of BASE_SCHEMA) readScript(workDb, file);
      sqlite(
        workDb,
        `INSERT INTO authorities (id, name, bulstat, type) VALUES ('auth:1', 'Authority line 1
Authority line 2', '1', 'public');
         INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES ('eik:200000002', 'Bidder', '200000002', '200000002', 1, 'company');
         INSERT INTO tenders (id, source_id, title, authority_id, currency, procedure_type, status) VALUES ('t:1', '1', 'Tender', 'auth:1', 'BGN', 'open', 'awarded');
         INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, contract_number, signing_value, value_flag, amount_eur) VALUES ('c:o:1', 't:1', 'eik:200000002', 10, 'BGN', 'C1', 10, 'ok', 10 / 1.95583);
         INSERT INTO amendments (id, natural_key, contract_number, unp, description, source) VALUES ('am:1:C1:A1', 'am:1:C1:A1', 'C1', '1', 'Description line 1
Description line 2', 'test');
         INSERT INTO ocds_amendment_publications (ocid, contract_number, document_number, source, published_at, amount, kind, version_key)
           VALUES ('ocds-test', 'TEST-PENDING-SIGNING', 'TEST-REPORT', 'ocds:2026-06-08', '2026-06-08T00:00:00.000', 20, 'correction', '[]'),
                  ('ocds-test', 'TEST-RETIRED-ANNEX', 'TEST-METADATA', 'ocds:2026-06-08', '2026-06-08T00:00:00.000', NULL, 'metadata', '[]');
         INSERT INTO nuts_regions (nuts3, nuts3_name, nuts2, nuts2_name, nuts1, nuts1_name)
           VALUES ('BG000', 'Region', 'BG00', 'Region 2', 'BG0', 'Region 1');
         INSERT INTO data_freshness (source, rows, refreshed_at) VALUES ('eop', 1, '2026-06-08');`,
      );
      sqlite(
        workDb,
        `INSERT INTO ocds_supplier_appearances VALUES ('synthetic-appearance');
         INSERT INTO ocds_tender_buyers VALUES ('t:1', 'synthetic-appearance', 'ocds:2026-06-08', 'auth:1');
         INSERT INTO ocds_contract_buyers VALUES ('c:o:1', 'synthetic-appearance', 'ocds:2026-06-08', 'auth:1');
         INSERT INTO tenders (id, source_id, title, authority_id, procedure_type)
           VALUES ('t:2', '2', 'Pending synthetic procedure', 'auth:1', 'неизвестна');
         INSERT INTO synthetic_tenders_awaiting_buyer VALUES ('t:2');`,
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
      expect(
        d1Json(persistTo, 'SELECT contract_number, amount FROM contract_signing_corrections'),
      ).toEqual([{ contract_number: 'TEST-PENDING-SIGNING', amount: 20 }]);
      expect(
        d1Json(
          persistTo,
          "SELECT document_number FROM ocds_amendment_publications WHERE kind = 'metadata'",
        ),
      ).toEqual([{ document_number: 'TEST-METADATA' }]);
      expect(
        d1Json(
          persistTo,
          'SELECT * FROM ocds_tender_buyers JOIN ocds_supplier_appearances USING (appearance)',
        ),
      ).toEqual([
        {
          tender_id: 't:1',
          appearance: 'synthetic-appearance',
          source: 'ocds:2026-06-08',
          authority_id: 'auth:1',
        },
      ]);
      expect(d1Json(persistTo, 'SELECT * FROM ocds_contract_buyers')).toEqual([
        {
          contract_id: 'c:o:1',
          appearance: 'synthetic-appearance',
          source: 'ocds:2026-06-08',
          authority_id: 'auth:1',
        },
      ]);
      expect(d1Json(persistTo, 'SELECT tender_id FROM synthetic_tenders_awaiting_buyer')).toEqual([
        { tender_id: 't:2' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
