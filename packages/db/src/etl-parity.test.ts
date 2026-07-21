/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const schemaPath = resolve(root, 'packages/db/migrations/0000_init.sql');
const refreshSlicePath = resolve(root, 'scripts/refresh-slice.sql');
const normalizePath = resolve(root, 'scripts/normalize-raw.sql');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
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

// Both scripts independently implement "which amendment wins" for a contract via a
// ROW_NUMBER() OVER (PARTITION BY unp, contract_number ORDER BY published_at DESC, natural_key
// DESC) tie-break. This pulls the live ORDER BY clause text out of each script file (not a
// hand-copied duplicate) so that if either script's tie-break is ever edited to diverge again
// (as happened in the bug fixed by fb3ed1b, PR #257), the extracted clauses stop matching what
// this test runs and the assertion below goes red.
function extractOrderBy(scriptText: string, pattern: RegExp, label: string): string {
  const match = scriptText.match(pattern);
  if (!match?.[1]) {
    throw new Error(
      `Could not locate the amendment_winner ORDER BY clause in ${label} — ` +
        'the CTE shape has changed; update the extraction regex in etl-parity.test.ts.',
    );
  }
  return match[1].trim();
}

const refreshSliceOrderBy = extractOrderBy(
  readFileSync(refreshSlicePath, 'utf8'),
  /WITH amendment_winner AS \(\s*SELECT a\.unp, a\.contract_number, a\.value_after, a\.currency,\s*ROW_NUMBER\(\) OVER \(\s*PARTITION BY a\.unp, a\.contract_number\s*ORDER BY ([^)]+)\)/,
  'scripts/refresh-slice.sql',
);

const normalizeRawOrderBy = extractOrderBy(
  readFileSync(normalizePath, 'utf8'),
  /\), amendment_winner AS \(\s*SELECT unp, contract_number, currency,\s*ROW_NUMBER\(\) OVER \(\s*PARTITION BY unp, contract_number\s*ORDER BY ([^)]+)\)/,
  'scripts/normalize-raw.sql',
);

describe('amendment_winner tie-break parity (normalize-raw.sql vs refresh-slice.sql, #257)', () => {
  it('picks the same winning amendment (value_after/currency) on a published_at tie', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-etl-parity-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      readScript(dbPath, schemaPath);

      // Two amendments tie on published_at for the same contract. `id` is deliberately set to
      // sort the OPPOSITE way from `natural_key`, so that if either script's tie-break ever
      // regresses to order by `id` instead of `natural_key` (the exact class of bug fixed in
      // fb3ed1b), that script picks the other row and this test fails loudly.
      sqlite(
        dbPath,
        `INSERT INTO amendments
          (id, natural_key, contract_number, unp, value_before, value_after, value_delta,
           currency, published_at, document_number, description, source)
        VALUES
          ('id-aaa', 'nk-zzz-should-win', 'CONTRACT-PARITY', 'UNP-PARITY', 1000, 1500, 500,
           'EUR', '2026-06-03', 'AMD-PARITY-A', 'Should win the tie', 'eop:annexes:2026-06-01'),
          ('id-zzz', 'nk-aaa-should-lose', 'CONTRACT-PARITY', 'UNP-PARITY', 1000, 999, -1,
           'USD', '2026-06-03', 'AMD-PARITY-B', 'Should lose the tie', 'eop:annexes:2026-06-01');`,
      );

      const refreshWinner = sqliteJson<{ value_after: number; currency: string }>(
        dbPath,
        `SELECT value_after, currency FROM (
           SELECT a.value_after, a.currency,
             ROW_NUMBER() OVER (PARTITION BY a.unp, a.contract_number ORDER BY ${refreshSliceOrderBy}) AS win_rn
           FROM amendments a
           WHERE a.value_after IS NOT NULL
         ) WHERE win_rn = 1`,
      )[0];

      const normalizeWinner = sqliteJson<{ value_after: number; currency: string }>(
        dbPath,
        `SELECT value_after, currency FROM (
           SELECT value_after, currency,
             ROW_NUMBER() OVER (PARTITION BY unp, contract_number ORDER BY ${normalizeRawOrderBy}) AS win_rn
           FROM amendments
           WHERE value_after IS NOT NULL
         ) WHERE win_rn = 1`,
      )[0];

      expect(refreshWinner).toBeDefined();
      expect(normalizeWinner).toBeDefined();
      expect(
        refreshWinner,
        `refresh-slice.sql picked value_after=${refreshWinner?.value_after}/currency=${refreshWinner?.currency}, ` +
          `normalize-raw.sql picked value_after=${normalizeWinner?.value_after}/currency=${normalizeWinner?.currency} — ` +
          'the two amendment_winner tie-breaks have diverged (see #257 / fb3ed1b).',
      ).toEqual(normalizeWinner);

      // Sanity check: the winner should be the natural_key-DESC row, not the id-DESC row —
      // otherwise this fixture wouldn't actually exercise the tie-break at all.
      expect(refreshWinner).toEqual({ value_after: 1500, currency: 'EUR' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
