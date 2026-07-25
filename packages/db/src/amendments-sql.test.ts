/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AMENDMENTS_SQL } from './queries/details';

// Integration test for the REAL amendment-timeline query (AMENDMENTS_SQL, imported from details.ts —
// not a hand-copied mirror) against a SQLite built from the production migration. It exercises the
// actual ORDER BY and the FX subquery (the two things the review was about), and locks: the timeline's
// ordering reconciles with the served current_value derivation (refresh-slice.sql ≈L1059-1065), incl.
// the trailing description-only-annex edge, and foreign FX resolves via the same ≤10-day lookback as
// the headline. Mirrors the sqlite3-CLI harness of competition-sql.test.ts.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migration0 = resolve(root, 'packages/db/migrations/0000_init.sql');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
}
function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
}

// The production query with its two bound params filled in (unp='U', contract_number='C').
const TIMELINE = AMENDMENTS_SQL.replace(/\?/, "'U'").replace(/\?/, "'C'");
// Mirrors refresh-slice.sql ≈L1059-1065 — how the served current_value (the headline value) is derived.
const ETL_CURRENT = `SELECT a.value_after FROM amendments a
  WHERE a.unp = 'U' AND a.contract_number = 'C' AND a.value_after IS NOT NULL
  ORDER BY a.published_at DESC, a.id DESC LIMIT 1;`;
const VALUE_AFTER = 1; // column index in AMENDMENTS_SQL's SELECT
const DOC_NUMBER = 5;
const FX_RATE = 7;

// One amendment row; id = natural_key (as refresh-slice.sql's promote step writes it) and
// document_number = id (so the FX test can address rows by name).
function amd(
  id: string,
  published_at: string | null,
  value_after: number | null,
  currency = 'BGN',
) {
  const pub = published_at === null ? 'NULL' : `'${published_at}'`;
  const val = value_after === null ? 'NULL' : String(value_after);
  return `('${id}', '${id}', 'C', 'U', ${val}, '${currency}', ${pub}, '${id}', 'eop')`;
}
function insert(dbPath: string, rows: string[]): void {
  sqlite(
    dbPath,
    `INSERT INTO amendments (id, natural_key, contract_number, unp, value_after, currency, published_at, document_number, source) VALUES ${rows.join(',')};`,
  );
}

// All timeline rows in the query's real order, as column arrays. NO filtering — a NULL-value_after row
// is kept at its real position, so a trailing description-only annex is visible (renders „—").
function timelineRows(dbPath: string): string[][] {
  const out = sqlite(dbPath, TIMELINE).replace(/\r/g, '').replace(/\n+$/, '');
  return out === '' ? [] : out.split('\n').map((line) => line.split('|'));
}

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

describe('amendment timeline SQL (real SQLite, AMENDMENTS_SQL)', () => {
  it('reconciles the last value-bearing row with the ETL current_value (same-day id tie-break)', () => {
    withDb((dbPath) => {
      // Same day: id k2 > k1 → the ETL takes k2 (200). Ordering by document_number would pick 100.
      insert(dbPath, [
        amd('k0', '2024-01-01', 50),
        amd('k1', '2024-06-03', 100),
        amd('k2', '2024-06-03', 200),
      ]);
      const rows = timelineRows(dbPath);
      expect(Number(rows.at(-1)?.[VALUE_AFTER])).toBe(200); // last row == headline value
      expect(Number(sqlite(dbPath, ETL_CURRENT).trim())).toBe(200);
    });
  });

  it('keeps a trailing NULL-value annex last (shown „—") without breaking reconciliation', () => {
    withDb((dbPath) => {
      // The latest-dated annex is description-only (NULL value_after) — e.g. a deadline extension.
      insert(dbPath, [amd('k1', '2024-06-03', 200), amd('k2', '2024-09-01', null)]);
      const rows = timelineRows(dbPath);
      expect(rows.at(-1)?.[VALUE_AFTER]).toBe(''); // the real last row is the NULL one → renders „—"
      // …yet the last VALUE-bearing row still equals the headline (the ETL skips the NULL one too).
      const lastValueBearing = rows.filter((r) => r[VALUE_AFTER] !== '').at(-1);
      expect(Number(lastValueBearing?.[VALUE_AFTER])).toBe(200);
      expect(Number(sqlite(dbPath, ETL_CURRENT).trim())).toBe(200);
    });
  });

  it('resolves foreign FX via the ≤10-day lookback (weekend), and none when outside the window', () => {
    withDb((dbPath) => {
      sqlite(
        dbPath,
        `INSERT INTO fx_rates (base_currency, rate_date, eur_per_unit, source, fetched_at)
         VALUES ('USD', '2024-06-06', 0.92, 'ecb', '2024-06-07');`,
      );
      insert(dbPath, [
        amd('kSat', '2024-06-08', 1000, 'USD'),
        amd('kFar', '2024-06-17', 1000, 'USD'),
      ]);
      const byId = new Map(timelineRows(dbPath).map((r) => [r[DOC_NUMBER], r]));
      expect(byId.get('kSat')?.[FX_RATE]).toBe('0.92'); // Saturday → Thursday's rate via the lookback
      expect(byId.get('kFar')?.[FX_RATE]).toBe(''); // 11 days later → outside the window → null → „—"
    });
  });
});
