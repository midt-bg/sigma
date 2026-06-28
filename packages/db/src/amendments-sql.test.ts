/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Integration test for the /contracts/:id amendment-timeline SQL (getContract). The query-layer unit
// tests (queries/details.test.ts) use a fake D1 and so never exercise the actual ORDER BY or the FX
// subquery; this runs the same SQL shape against a real SQLite built from the production migration.
// It locks the two things the reviewer flagged: (1) the timeline's last row reconciles with the ETL's
// current_value pick (same ordering keys, incl. the same-day tie-break and NULL-date handling), and
// (2) foreign-currency annexes resolve FX via the same ≤10-day lookback the headline uses.
// Mirrors the sqlite3-CLI harness of competition-sql.test.ts (no better-sqlite3 dependency).

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migration0 = resolve(root, 'packages/db/migrations/0000_init.sql');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' }).trim();
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
}

function amd(natural_key: string, published_at: string | null, value_after: number | null, currency = 'BGN') {
  const pub = published_at === null ? 'NULL' : `'${published_at}'`;
  const val = value_after === null ? 'NULL' : String(value_after);
  return `('${natural_key}', '${natural_key}', 'C', 'U', ${val}, '${currency}', ${pub}, '${natural_key}', 'eop')`;
}

// The timeline ordering the page uses (getContract): published_at, natural_key — NULLs first in ASC.
const TIMELINE_VALUES = `
SELECT am.value_after FROM amendments am
WHERE am.unp = 'U' AND am.contract_number = 'C'
ORDER BY am.published_at, am.natural_key;`;

// What derive-amendments.sql sets current_value to: the latest non-null value_after.
const ETL_CURRENT = `
SELECT a.value_after FROM amendments a
WHERE a.unp = 'U' AND a.contract_number = 'C' AND a.value_after IS NOT NULL
ORDER BY a.published_at DESC, a.natural_key DESC LIMIT 1;`;

const FX_RATE = (currency: string, date: string) => `
SELECT COALESCE((SELECT f.eur_per_unit FROM fx_rates f
   WHERE f.base_currency = '${currency}'
     AND f.rate_date <= '${date}'
     AND f.rate_date >= date('${date}', '-10 days')
   ORDER BY f.rate_date DESC LIMIT 1), 'NONE');`;

function withDb<T>(fn: (dbPath: string) => T): T {
  const dir = mkdtempSync(resolve(tmpdir(), 'sigma-amendments-'));
  const dbPath = resolve(dir, 'test.sqlite');
  try {
    readScript(dbPath, migration0);
    return fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// REAL columns print as `200.0`, so compare as numbers, not strings.
const lastValue = (dbPath: string) =>
  Number(sqlite(dbPath, TIMELINE_VALUES).split('\n').filter(Boolean).at(-1));
const etlCurrent = (dbPath: string) => Number(sqlite(dbPath, ETL_CURRENT));

describe('amendment timeline SQL (real SQLite)', () => {
  it('reconciles the last timeline row with the ETL current_value, incl. the same-day tie-break', () => {
    withDb((dbPath) => {
      // Two annexes on the SAME day: natural_key k2 > k1 → the ETL takes k2 (200) as current_value.
      // Ordering by document_number instead of natural_key would have put 100 last (the bug).
      sqlite(
        dbPath,
        `INSERT INTO amendments (id, natural_key, contract_number, unp, value_after, currency, published_at, document_number, source) VALUES
          ${amd('k0', '2024-01-01', 50)},
          ${amd('k1', '2024-06-03', 100)},
          ${amd('k2', '2024-06-03', 200)};`,
      );
      expect(lastValue(dbPath)).toBe(200);
      expect(etlCurrent(dbPath)).toBe(200); // the page's last row == the headline value
    });
  });

  it('sorts a NULL-dated annex first, so it never displaces the latest value', () => {
    withDb((dbPath) => {
      sqlite(
        dbPath,
        `INSERT INTO amendments (id, natural_key, contract_number, unp, value_after, currency, published_at, document_number, source) VALUES
          ${amd('k1', '2024-06-03', 200)},
          ${amd('kNULL', null, 999)};`,
      );
      // NULL date is rendered first (oldest/undated), so the last row stays the dated 200 — matching
      // the ETL, which (ORDER BY published_at DESC) also never treats a NULL-dated annex as latest.
      expect(lastValue(dbPath)).toBe(200);
      expect(etlCurrent(dbPath)).toBe(200);
    });
  });

  it('resolves foreign FX via a ≤10-day lookback (weekend), and yields none when outside the window', () => {
    withDb((dbPath) => {
      sqlite(
        dbPath,
        `INSERT INTO fx_rates (base_currency, rate_date, eur_per_unit, source, fetched_at)
         VALUES ('USD', '2024-06-06', 0.92, 'ecb', '2024-06-07');`,
      );
      // Saturday 2024-06-08 has no exact rate; the ≤10-day lookback finds Thursday's 0.92.
      expect(sqlite(dbPath, FX_RATE('USD', '2024-06-08'))).toBe('0.92');
      // 11 days later → outside the window → no rate (the row would render „—", honestly).
      expect(sqlite(dbPath, FX_RATE('USD', '2024-06-17'))).toBe('NONE');
    });
  });
});
