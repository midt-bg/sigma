/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const schemaPath = resolve(root, 'packages/db/migrations/0000_init.sql');
const precomputePath = resolve(root, 'scripts/precompute.sql');

function sqlite(dbPath: string, sql: string): void {
  execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
}

function sqliteJson<T>(dbPath: string, sql: string): T[] {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
  return out ? (JSON.parse(out) as T[]) : [];
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', [dbPath], {
    input: `PRAGMA foreign_keys=ON;\n.read ${path}\n`,
    stdio: 'pipe',
  });
}

// One tender/bidder/authority parent, then contracts seeded straight into the domain table (bypassing
// raw_*/normalize) with the exact bid counts and signing/current values each flag case needs. EUR
// currency so the section-0 EUR timeline copies the figures as-is and the 0.20-vs-0.21 markup boundary
// is exact (no BGN-peg float noise). One precompute run covers every case.
let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'sigma-risk-flags-'));
  dbPath = resolve(dir, 'test.sqlite');
  readScript(dbPath, schemaPath);
  sqlite(
    dbPath,
    `PRAGMA foreign_keys=ON;
INSERT INTO authorities (id, name, bulstat, type) VALUES ('auth:1', 'A', '100000001', 'public');
INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind)
  VALUES ('eik:1', 'B', '200000001', '200000001', 1, 'company');
INSERT INTO tenders (id, source_id, title, authority_id, estimated_value, currency, procedure_type, status)
  VALUES ('t:1', 'UNP-1', 'T', 'auth:1', 1000, 'EUR', 'open', 'awarded');
INSERT INTO contracts
  (id, tender_id, bidder_id, amount, currency, signing_value, current_value, value_flag, bids_received)
VALUES
  ('c:so1', 't:1', 'eik:1', 1000, 'EUR', NULL, NULL, 'ok', 1),
  ('c:so3', 't:1', 'eik:1', 1000, 'EUR', NULL, NULL, 'ok', 3),
  ('c:soN', 't:1', 'eik:1', 1000, 'EUR', NULL, NULL, 'ok', NULL),
  ('c:hmB', 't:1', 'eik:1', 1000, 'EUR', 1000, 1200, 'ok', 2),
  ('c:hm1', 't:1', 'eik:1', 1000, 'EUR', 1000, 1210, 'ok', 2),
  ('c:hmS', 't:1', 'eik:1', 1000, 'EUR', 1000, 5000, 'value_suspect', 2),
  ('c:hm0', 't:1', 'eik:1', 1000, 'EUR', 1000, 1000, 'ok', 2),
  ('c:hmR', 't:1', 'eik:1', 1000, 'EUR', 1000, 1400, 'review', 2),
  ('c:hmL', 't:1', 'eik:1', 1000, 'EUR', 1000, 1400, 'value_low', 2);`,
  );
  readScript(dbPath, precomputePath);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function flag(id: string, col: 'is_single_offer' | 'is_high_markup'): number | null {
  const row = sqliteJson<Record<string, number | null>>(
    dbPath,
    `SELECT ${col} FROM contracts WHERE id = '${id}'`,
  )[0];
  return row?.[col] ?? null;
}

describe('per-contract risk flags (#229, precompute)', () => {
  it('flags single-offer when bids_received = 1', () => {
    expect(flag('c:so1', 'is_single_offer')).toBe(1);
  });

  it('does not flag single-offer when more than one bid was received', () => {
    expect(flag('c:so3', 'is_single_offer')).toBe(0);
  });

  it('leaves single-offer NULL when the bid count is unknown', () => {
    expect(flag('c:soN', 'is_single_offer')).toBe(null);
  });

  it('does not flag high-markup at the 20% boundary (strictly greater than)', () => {
    expect(flag('c:hmB', 'is_high_markup')).toBe(0);
  });

  it('flags high-markup above 20%', () => {
    expect(flag('c:hm1', 'is_high_markup')).toBe(1);
  });

  it('leaves high-markup NULL for a value-suspect row (no trustworthy EUR figures)', () => {
    expect(flag('c:hmS', 'is_high_markup')).toBe(null);
  });

  it('does not flag high-markup with no markup', () => {
    expect(flag('c:hm0', 'is_high_markup')).toBe(0);
  });

  // The contract page marks review/value_low rows as suspect and hides the badge; the flag must match
  // (else the rollup counts a markup the page won't show). #229 review finding.
  it('leaves high-markup NULL for a review row despite a >20% markup', () => {
    expect(flag('c:hmR', 'is_high_markup')).toBe(null);
  });

  it('leaves high-markup NULL for a value_low row despite a >20% markup', () => {
    expect(flag('c:hmL', 'is_high_markup')).toBe(null);
  });
});
