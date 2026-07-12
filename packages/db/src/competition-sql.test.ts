/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Integration test for the /competition analytics SQL. The query layer's unit tests (queries/
// competition.test.ts) use a fake D1 and so never run the actual aggregation; this runs the same SQL
// shape against a real SQLite built from the production migration, with a deterministic fixture, and
// asserts the numbers: the single-offer share, the HHI, the min-contracts HAVING gate and the
// "at least 2 suppliers" filter. Mirrors the sqlite3-CLI harness of migrations.test.ts /
// refresh-slice.test.ts (no better-sqlite3 dependency, same as the rest of the suite).

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migration0 = resolve(root, 'packages/db/migrations/0000_init.sql');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' }).trim();
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
}

// Authority А: 10 awarded contracts, 8 of them single-offer (bids_received = 1) → share 0.8; spend
// split 6:4 between two suppliers → HHI = 0.6² + 0.4² = 0.52, suppliers = 2.
// Authority Б: 2 contracts, one supplier → below the HAVING gate and below the 2-supplier floor.
const FIXTURE = `
INSERT INTO authorities (id, name, bulstat, type_group) VALUES
  ('auth:A', 'Институция А', '100000001', 'община'),
  ('auth:B', 'Институция Б', '100000002', 'община');
INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
  ('eik:X', 'Фирма Х', '200000001', '200000001', 1, 'company'),
  ('eik:Y', 'Фирма У', '200000002', '200000002', 1, 'company');
INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type, status) VALUES
  ('t:A', 'UNP-A', 'Поръчка А', 'auth:A', '45', 'открита процедура', 'awarded'),
  ('t:B', 'UNP-B', 'Поръчка Б', 'auth:B', '45', 'открита процедура', 'awarded');
INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, bids_received, value_flag, amount_eur) VALUES
  ('c:A1',  't:A', 'eik:X', 1000, 'EUR', '2024-01-01', 1, 'ok', 1000),
  ('c:A2',  't:A', 'eik:X', 1000, 'EUR', '2024-01-02', 1, 'ok', 1000),
  ('c:A3',  't:A', 'eik:X', 1000, 'EUR', '2024-01-03', 1, 'ok', 1000),
  ('c:A4',  't:A', 'eik:X', 1000, 'EUR', '2024-01-04', 1, 'ok', 1000),
  ('c:A5',  't:A', 'eik:X', 1000, 'EUR', '2024-01-05', 1, 'ok', 1000),
  ('c:A6',  't:A', 'eik:X', 1000, 'EUR', '2024-01-06', 1, 'ok', 1000),
  ('c:A7',  't:A', 'eik:Y', 1000, 'EUR', '2024-01-07', 1, 'ok', 1000),
  ('c:A8',  't:A', 'eik:Y', 1000, 'EUR', '2024-01-08', 1, 'ok', 1000),
  ('c:A9',  't:A', 'eik:Y', 1000, 'EUR', '2024-01-09', 3, 'ok', 1000),
  ('c:A10', 't:A', 'eik:Y', 1000, 'EUR', '2024-01-10', 3, 'ok', 1000),
  ('c:B1',  't:B', 'eik:X', 1000, 'EUR', '2024-02-01', 1, 'ok', 1000),
  ('c:B2',  't:B', 'eik:X', 1000, 'EUR', '2024-02-02', 1, 'ok', 1000);
`;

// Single-offer leaderboard (mirrors authoritiesBySingleOffer; min-contracts gate = 4 for the fixture).
const SINGLE_OFFER_SQL = `
SELECT a.name, ROUND(SUM(CASE WHEN c.bids_received = 1 THEN 1 ELSE 0 END) * 1.0 / COUNT(*), 2) AS share
FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id
WHERE c.bids_received IS NOT NULL AND c.bids_received >= 1
GROUP BY t.authority_id
HAVING COUNT(*) >= 4
ORDER BY share DESC, a.name;
`;

// Supplier concentration (mirrors authoritiesByConcentration; suppliers >= 2 floor).
const HHI_SQL = `
WITH pair AS (
  SELECT t.authority_id AS aid, c.bidder_id AS bid, SUM(c.amount_eur) AS spent
  FROM contracts c JOIN tenders t ON t.id = c.tender_id
  WHERE c.amount_eur IS NOT NULL
  GROUP BY t.authority_id, c.bidder_id
),
tot AS (SELECT aid, SUM(spent) AS total, COUNT(*) AS suppliers FROM pair GROUP BY aid)
SELECT a.name, ROUND(SUM((p.spent / tot.total) * (p.spent / tot.total)), 2) AS hhi, tot.suppliers
FROM pair p JOIN tot ON tot.aid = p.aid JOIN authorities a ON a.id = p.aid
WHERE tot.suppliers >= 2
GROUP BY p.aid
ORDER BY hhi DESC, a.name;
`;

// Recurring-pairs fixture: two ties, proving the ORDER BY authority_id, bidder_id tie-breakers
// (added to topRecurringPairs' filtered-branch query) resolve against the SELECT list's own
// aliases (t.authority_id AS authority_id, c.bidder_id AS bidder_id) rather than failing or
// falling back to insertion order. Group 1 ties on contracts=3/won_eur=3000 across two
// authorities (PY, PZ) — PY must sort first. Group 2 ties on contracts=2/won_eur=2000 within one
// authority (PW) across two bidders (PE, PF) — PE must sort first.
const PAIRS_FIXTURE = `
INSERT INTO authorities (id, name, bulstat, type_group) VALUES
  ('auth:PY', 'Институция PY', '300000001', 'община'),
  ('auth:PZ', 'Институция PZ', '300000002', 'община'),
  ('auth:PW', 'Институция PW', '300000003', 'община');
INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
  ('eik:PB', 'Фирма PB', '400000001', '400000001', 1, 'company'),
  ('eik:PC', 'Фирма PC', '400000002', '400000002', 1, 'company'),
  ('eik:PE', 'Фирма PE', '400000003', '400000003', 1, 'company'),
  ('eik:PF', 'Фирма PF', '400000004', '400000004', 1, 'company');
INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type, status) VALUES
  ('t:PY', 'UNP-PY', 'Поръчка PY', 'auth:PY', '45', 'открита процедура', 'awarded'),
  ('t:PZ', 'UNP-PZ', 'Поръчка PZ', 'auth:PZ', '45', 'открита процедура', 'awarded'),
  ('t:PW', 'UNP-PW', 'Поръчка PW', 'auth:PW', '45', 'открита процедура', 'awarded');
INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, bids_received, value_flag, amount_eur) VALUES
  ('c:PZ1', 't:PZ', 'eik:PB', 1000, 'EUR', '2024-01-01', 1, 'ok', 1000),
  ('c:PZ2', 't:PZ', 'eik:PB', 1000, 'EUR', '2024-01-02', 1, 'ok', 1000),
  ('c:PZ3', 't:PZ', 'eik:PB', 1000, 'EUR', '2024-01-03', 1, 'ok', 1000),
  ('c:PY1', 't:PY', 'eik:PC', 1000, 'EUR', '2024-01-01', 1, 'ok', 1000),
  ('c:PY2', 't:PY', 'eik:PC', 1000, 'EUR', '2024-01-02', 1, 'ok', 1000),
  ('c:PY3', 't:PY', 'eik:PC', 1000, 'EUR', '2024-01-03', 1, 'ok', 1000),
  ('c:PW1', 't:PW', 'eik:PF', 1000, 'EUR', '2024-01-01', 1, 'ok', 1000),
  ('c:PW2', 't:PW', 'eik:PF', 1000, 'EUR', '2024-01-02', 1, 'ok', 1000),
  ('c:PW3', 't:PW', 'eik:PE', 1000, 'EUR', '2024-01-01', 1, 'ok', 1000),
  ('c:PW4', 't:PW', 'eik:PE', 1000, 'EUR', '2024-01-02', 1, 'ok', 1000);
`;

// Mirrors topRecurringPairs' filtered-branch query (queries/competition.ts): same JOINs, GROUP BY,
// and ORDER BY tie-breakers, minus the display-only name columns.
const PAIRS_SQL = `
SELECT t.authority_id AS authority_id, c.bidder_id AS bidder_id,
       COUNT(*) AS contracts, SUM(c.amount_eur) AS won_eur
FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id
JOIN bidders b ON b.id = c.bidder_id
WHERE c.amount_eur IS NOT NULL
GROUP BY t.authority_id, c.bidder_id
ORDER BY contracts DESC, won_eur DESC, authority_id, bidder_id;
`;

describe('competition SQL (real SQLite)', () => {
  function withDb<T>(fn: (dbPath: string) => T): T {
    return withFixture(FIXTURE, fn);
  }

  function withFixture<T>(fixture: string, fn: (dbPath: string) => T): T {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-competition-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      readScript(dbPath, migration0);
      sqlite(dbPath, fixture);
      return fn(dbPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('computes the single-offer share and applies the min-contracts gate', () => {
    withDb((dbPath) => {
      // Authority Б (2 contracts) is below the gate, so only А is returned, at 8/10 = 0.8.
      expect(sqlite(dbPath, SINGLE_OFFER_SQL)).toBe('Институция А|0.8');
    });
  });

  it('computes HHI and keeps only authorities with at least two suppliers', () => {
    withDb((dbPath) => {
      // Б has a single supplier (excluded); А splits 6:4 → 0.36 + 0.16 = 0.52 over 2 suppliers.
      expect(sqlite(dbPath, HHI_SQL)).toBe('Институция А|0.52|2');
    });
  });

  it('resolves the authority_id/bidder_id ORDER BY aliases and breaks ties deterministically', () => {
    withFixture(PAIRS_FIXTURE, (dbPath) => {
      expect(sqlite(dbPath, PAIRS_SQL)).toBe(
        [
          'auth:PY|eik:PC|3|3000.0',
          'auth:PZ|eik:PB|3|3000.0',
          'auth:PW|eik:PE|2|2000.0',
          'auth:PW|eik:PF|2|2000.0',
        ].join('\n'),
      );
    });
  });
});
