import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const migrationDir = 'packages/db/migrations';
const migrations = readdirSync(resolve(root, migrationDir))
  .filter((name) => name.endsWith('.sql'))
  .sort();

const handles: DatabaseSync[] = [];

afterEach(() => {
  for (const db of handles.splice(0)) db.close();
});

interface PlanRow {
  id: number;
  parent: number;
  notused: number;
  detail: string;
}

function createStagingDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  handles.push(db);
  for (const migration of migrations) {
    db.exec(read(`${migrationDir}/${migration}`));
  }
  db.exec(read('scripts/work-staging-schema.sql'));
  db.exec(`
    CREATE TABLE contractor_identity (
      eik_raw    TEXT,
      name_raw   TEXT,
      name_norm  TEXT,
      eik_clean  TEXT,
      eik_valid  INTEGER NOT NULL,
      eik_status TEXT NOT NULL,
      bidder_key TEXT NOT NULL,
      PRIMARY KEY (eik_raw, name_raw)
    );
    CREATE TABLE raw_contract_value_results AS SELECT * FROM raw_contract_values;
    CREATE UNIQUE INDEX idx_raw_contract_value_results ON raw_contract_value_results(id);
    CREATE TABLE raw_contract_value_existing AS
      SELECT id, tender_id, amount, ocds_signing_incomplete FROM contracts WHERE 0;
    CREATE UNIQUE INDEX idx_raw_contract_value_existing ON raw_contract_value_existing(id);
  `);
  return db;
}

function extractInsertContractsStatement(scriptPath: string): string {
  const sql = read(scriptPath);
  const match = sql.match(
    /WITH\s+incomplete_signings\b[\s\S]*?INSERT\s+OR\s+IGNORE\s+INTO\s+contracts\b[\s\S]*?;/,
  );
  if (!match) {
    throw new Error(`Could not find INSERT OR IGNORE INTO contracts statement in ${scriptPath}`);
  }
  return match[0];
}

describe('INSERT OR IGNORE INTO contracts query plan', () => {
  it.each(['scripts/normalize-raw.sql', 'scripts/refresh-slice.sql'])(
    '%s uses an index lookup for raw_contract_value_inputs (no O(N^2) nested scan)',
    (scriptPath) => {
      const db = createStagingDb();
      const stmt = extractInsertContractsStatement(scriptPath);
      const rows = db.prepare(`EXPLAIN QUERY PLAN ${stmt}`).all() as unknown as PlanRow[];

      const details = rows.map((r) => r.detail);
      expect(details.some((d) => /^SEARCH i USING INDEX\b/.test(d))).toBe(true);
      expect(details.some((d) => /^SCAN i\b/.test(d))).toBe(false);

      const outerScans = rows.filter((r) => r.parent === 0 && /^SCAN\b/.test(r.detail));
      expect(outerScans.length).toBeLessThanOrEqual(1);
    },
  );
});
