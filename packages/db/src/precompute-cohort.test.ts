/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrations = [
  resolve(root, 'packages/db/migrations/0000_init.sql'),
  resolve(root, 'packages/db/migrations/0001_flow_pairs_bidder_index.sql'),
  resolve(root, 'packages/db/migrations/0003_cpv_division_stats.sql'),
];
const precomputePath = resolve(root, 'scripts/precompute.sql');
const refreshSlicePath = resolve(root, 'scripts/refresh-slice.sql');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
}

function sqliteJson<T>(dbPath: string, sql: string): T[] {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
  return out ? (JSON.parse(out) as T[]) : [];
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
}

interface StatsRow {
  division: string;
  priced_contracts: number;
  p25_eur: number;
  median_eur: number;
  p75_eur: number;
  p90_eur: number;
  p95_eur: number;
  p99_eur: number;
}

describe('precompute cpv_division_stats', () => {
  it('computes nearest-rank percentiles per division over the clean-value cohort', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-cohort-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      for (const migration of migrations) readScript(dbPath, migration);

      // Division 45: 20 clean contracts valued 1000..20000 EUR, plus rows the cohort must exclude
      // (suspect flag, NULL amount, zero amount, missing CPV). Division 30: a small 3-row cohort
      // still gets a stats row - the MIN_COHORT floor is applied read-side, not here.
      const stmts: string[] = [
        `INSERT INTO authorities (id, name) VALUES ('auth:1', 'Възложител');`,
        `INSERT INTO bidders (id, name) VALUES ('eik:1', 'Изпълнител');`,
        `INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type)
         VALUES ('t:45', 'UNP-45', 'Строителство', 'auth:1', '45000000', 'открита процедура'),
                ('t:30', 'UNP-30', 'Техника', 'auth:1', '30200000', 'открита процедура'),
                ('t:none', 'UNP-NONE', 'Без CPV', 'auth:1', NULL, 'открита процедура');`,
      ];
      for (let i = 1; i <= 20; i += 1) {
        stmts.push(
          `INSERT INTO contracts (id, tender_id, bidder_id, amount, amount_eur, value_flag)
           VALUES ('c:45-${i}', 't:45', 'eik:1', ${i * 1000}, ${i * 1000}, 'ok');`,
        );
      }
      stmts.push(
        `INSERT INTO contracts (id, tender_id, bidder_id, amount, amount_eur, value_flag)
         VALUES ('c:45-suspect', 't:45', 'eik:1', 9e9, 9e9, 'value_suspect'),
                ('c:45-null', 't:45', 'eik:1', 5, NULL, 'ok'),
                ('c:45-zero', 't:45', 'eik:1', 0, 0, 'ok'),
                ('c:no-cpv', 't:none', 'eik:1', 7000, 7000, 'ok'),
                ('c:30-1', 't:30', 'eik:1', 100, 100, 'ok'),
                ('c:30-2', 't:30', 'eik:1', 200, 200, 'ok'),
                ('c:30-3', 't:30', 'eik:1', 300, 300, 'ok');`,
      );
      sqlite(dbPath, stmts.join('\n'));

      readScript(dbPath, precomputePath);

      const rows = sqliteJson<StatsRow>(
        dbPath,
        'SELECT * FROM cpv_division_stats ORDER BY division;',
      );
      expect(rows).toHaveLength(2);

      // n=20 → nearest-rank k = ceil(q*20): p25→5th, p50→10th, p75→15th, p90→18th, p95→19th, p99→20th.
      expect(rows[1]).toEqual({
        division: '45',
        priced_contracts: 20,
        p25_eur: 5000,
        median_eur: 10000,
        p75_eur: 15000,
        p90_eur: 18000,
        p95_eur: 19000,
        p99_eur: 20000,
      });

      // n=3 → k = ceil(q*3): p25→1st, p50→2nd, p75/p90/p95/p99→3rd.
      expect(rows[0]).toEqual({
        division: '30',
        priced_contracts: 3,
        p25_eur: 100,
        median_eur: 200,
        p75_eur: 300,
        p90_eur: 300,
        p95_eur: 300,
        p99_eur: 300,
      });

      // Idempotent: a re-run reflects current rows, no duplicates or drift.
      readScript(dbPath, precomputePath);
      expect(
        sqlite(dbPath, "SELECT COUNT(*) FROM cpv_division_stats WHERE division = '45';").trim(),
      ).toBe('1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the refresh-slice rebuild identical to the precompute one', () => {
    // Both files carry a full-rebuild copy of the same statement (small global rollup, like
    // sector_totals). Extract INSERT INTO cpv_division_stats ... ; from each and compare with
    // whitespace normalised, so the two paths cannot silently drift apart.
    const extract = (path: string): string => {
      const sql = readFileSync(path, 'utf8');
      const m = /INSERT INTO cpv_division_stats[\s\S]*?;/.exec(sql);
      if (!m) throw new Error(`no cpv_division_stats insert in ${path}`);
      return m[0].replace(/\s+/g, ' ').trim();
    };
    expect(extract(refreshSlicePath)).toBe(extract(precomputePath));
  });
});
