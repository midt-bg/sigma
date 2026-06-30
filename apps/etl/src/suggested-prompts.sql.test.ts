/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SLOT1_SQL, SLOT2_SQL, SLOT3_SQL, SLOT4_SQL } from './suggested-prompts';

// Integration test for the starter-prompt slot SQL. The pure-logic unit tests (suggested-prompts.test
// .ts) never run the actual aggregation; this builds a real SQLite from the production migrations
// (0000_init + 0001_assistant_prompts) with a deterministic fixture and asserts the numbers each slot
// query returns: the as_of-anchored window, the slot-4 denominator exclusions, and the
// amount_eur-IS-NOT-NULL sum posture. Mirrors the sqlite3-CLI harness of competition-sql.test.ts (no
// better-sqlite3 dependency, same as the rest of the suite).

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migration0 = resolve(root, 'packages/db/migrations/0000_init.sql');
const migration1 = resolve(root, 'packages/db/migrations/0001_assistant_prompts.sql');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' }).trim();
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
}

// as_of = 2024-01-10. The 7-day window is signed_at ∈ (2024-01-03, 2024-01-10].
//   c:in1  2024-01-05  amount_eur 1000  sector 45  bids 1  open       → in window, single-offer
//   c:in2  2024-01-08  amount_eur 9000  sector 45  bids 3  open       → in window, top contract
//   c:in3  2024-01-10  amount_eur  500  sector 15  bids 1  open       → in window (boundary inclusive)
//   c:edge 2024-01-03  amount_eur 7000  sector 45  bids 1  open       → EXCLUDED (boundary exclusive)
//   c:late 2024-01-11  amount_eur 8000  sector 45  bids 1  open       → EXCLUDED (after as_of)
//   c:nul  2024-01-06  amount_eur NULL  sector 45  bids 1  open       → EXCLUDED from sums
//   c:unk  2024-01-07  amount_eur 4000  sector 45  bids 1  неизвестна → EXCLUDED from slot 4 denom
//   c:nob  2024-01-07  amount_eur 3000  sector 45  bids NULL open     → EXCLUDED from slot 4 denom
const FIXTURE = `
INSERT INTO home_totals (id, contracts, value_eur, authorities, bidders, suspect, as_of, refreshed_at)
  VALUES (1, 8, 25000, 1, 1, 0, '2024-01-10', '2024-01-10T00:00:00Z');
INSERT INTO authorities (id, name) VALUES ('auth:A', 'Институция А');
INSERT INTO bidders (id, name) VALUES ('eik:X', 'Фирма Х');
INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type, status) VALUES
  ('t:open', 'UNP-O', 'Открита', 'auth:A', '45000000', 'открита процедура', 'awarded'),
  ('t:food', 'UNP-F', 'Храни',   'auth:A', '15000000', 'открита процедура', 'awarded'),
  ('t:unk',  'UNP-U', 'Синтет.', 'auth:A', '45000000', 'неизвестна', 'awarded');
INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, bids_received, value_flag, amount_eur) VALUES
  ('c:in1',  't:open', 'eik:X', 1000, 'EUR', '2024-01-05', 1, 'ok', 1000),
  ('c:in2',  't:open', 'eik:X', 9000, 'EUR', '2024-01-08', 3, 'ok', 9000),
  ('c:in3',  't:food', 'eik:X',  500, 'EUR', '2024-01-10', 1, 'ok', 500),
  ('c:edge', 't:open', 'eik:X', 7000, 'EUR', '2024-01-03', 1, 'ok', 7000),
  ('c:late', 't:open', 'eik:X', 8000, 'EUR', '2024-01-11', 1, 'ok', 8000),
  ('c:nul',  't:open', 'eik:X', 4000, 'EUR', '2024-01-06', 1, 'ok', NULL),
  ('c:unk',  't:unk',  'eik:X', 4000, 'EUR', '2024-01-07', 1, 'ok', 4000),
  ('c:nob',  't:open', 'eik:X', 3000, 'EUR', '2024-01-07', NULL, 'ok', 3000);
`;

function withDb<T>(fn: (dbPath: string) => T): T {
  const dir = mkdtempSync(resolve(tmpdir(), 'sigma-prompts-'));
  const dbPath = resolve(dir, 'test.sqlite');
  try {
    readScript(dbPath, migration0);
    readScript(dbPath, migration1);
    sqlite(dbPath, FIXTURE);
    return fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The exported SQL binds ?1 = as_of (text) and ?2 = window days (integer). The sqlite3 CLI's
// `.param set` evaluates its value as a SQL expression (so '2024-01-10' would be parsed as 2024−01−10
// arithmetic), so instead we substitute the two parameters with correctly-typed SQL literals and run
// the exact exported query text. In production D1 these arrive as typed values via .bind(asOf, days).
function runSlot(dbPath: string, sql: string, asOf: string, days: number): string {
  const bound = sql.replaceAll('?1', `'${asOf}'`).replaceAll('?2', String(days));
  return execFileSync('sqlite3', ['-bail', dbPath], {
    input: `${bound}\n`,
    encoding: 'utf8',
  }).trim();
}

describe('suggested-prompts slot SQL (real SQLite)', () => {
  it('slot 1 picks the biggest in-window contract and excludes boundary/after/NULL rows', () => {
    withDb((dbPath) => {
      // Top row = c:in2 (9000); c:edge (2024-01-03, 7000) and c:late are out of window; c:nul is NULL.
      const out = runSlot(dbPath, SLOT1_SQL, '2024-01-10', 7);
      const firstLine = out.split('\n')[0];
      expect(firstLine).toBe('Институция А|9000.0|ok|45');
    });
  });

  it('slot 1 excludes a value_suspect row even when it is the largest in-window amount', () => {
    withDb((dbPath) => {
      // A repaired-but-flagged row larger than the top 'ok' contract (c:in2 = 9000). The NAMED headline
      // gates on value_flag = 'ok', so this must NOT be picked — slot 1 stays on c:in2.
      sqlite(
        dbPath,
        `INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, bids_received, value_flag, amount_eur)
         VALUES ('c:susp', 't:open', 'eik:X', 12000, 'EUR', '2024-01-09', 2, 'value_suspect', 12000);`,
      );
      const firstLine = runSlot(dbPath, SLOT1_SQL, '2024-01-10', 7).split('\n')[0];
      expect(firstLine).toBe('Институция А|9000.0|ok|45');
    });
  });

  it('slot 2 sums signed spend per CPV division over amount_eur IS NOT NULL', () => {
    withDb((dbPath) => {
      // Division 45 in window: c:in1 1000 + c:in2 9000 + c:unk 4000 + c:nob 3000 = 17000 over 4 rows.
      // (c:nul NULL excluded; c:edge/c:late out of window.) Division 15 = 500. Top = 45.
      expect(runSlot(dbPath, SLOT2_SQL, '2024-01-10', 7)).toBe('45|17000.0|4');
    });
  });

  it('slot 3 counts and sums all in-window non-NULL contracts', () => {
    withDb((dbPath) => {
      // In window, amount_eur NOT NULL: c:in1 1000 + c:in2 9000 + c:in3 500 + c:unk 4000 + c:nob 3000
      // = 17500 over 5 rows. (c:edge/c:late out of window; c:nul NULL.)
      expect(runSlot(dbPath, SLOT3_SQL, '2024-01-10', 7)).toBe('5|17500.0');
    });
  });

  it('slot 4 denominator excludes неизвестна procedure and null bids_received', () => {
    withDb((dbPath) => {
      // Qualifying (bids>=1, procedure<>неизвестна, in window): c:in1, c:in2, c:in3 = 3 total;
      // single-offer (bids=1): c:in1, c:in3 = 2. c:unk (неизвестна) and c:nob (NULL bids) excluded.
      expect(runSlot(dbPath, SLOT4_SQL, '2024-01-10', 7)).toBe('2|3');
    });
  });
});
