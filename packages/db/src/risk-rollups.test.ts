/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const schemaPath = resolve(root, 'packages/db/migrations/0000_init.sql');
const riskColumnsPath = resolve(root, 'packages/db/migrations/0006_subject_risk_columns.sql');
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

// One bidder (eik:1) and one authority (auth:1) over the SAME five contracts, so the company- and
// authority-side aggregates must come out identical. Chosen so the count-share (0.75) and value-share
// (0.35) genuinely diverge, and so the NULL-flag contract (K5) is excluded from the risk denominators
// even though it counts toward `contracts` — proving the denominators are not `contracts`.
//
//  id  bids  signing  current  value_flag      amount_eur   is_single_offer  is_high_markup
//  K1   1     1000     1000     ok               1000        1                0
//  K2   1     1000     1300     ok               2000        1                1  (deltaPct 0.30)
//  K3   1     1000     1000     ok                500        1                0
//  K4   3     1000     1000     ok               6500        0                0
//  K5  NULL   1000     5000     value_suspect    1000        NULL (bids)      NULL (suspect EUR)
//
// single-offer: k=3, n=4 (K1..K4)      → count 0.75 ; value 3500/10000 = 0.35
// high-markup : k=1, n=4 (K1..K4)      → count 0.25 ; value 2000/10000 = 0.20
interface RiskRow {
  single_offer_k: number;
  single_offer_n: number;
  single_offer_value_share: number;
  high_markup_k: number;
  high_markup_n: number;
  high_markup_value_share: number;
  contracts: number;
}

let dir: string;
let dbPath: string;

function riskRow(table: 'company_totals' | 'authority_totals', key: string): RiskRow {
  const col = table === 'company_totals' ? 'bidder_id' : 'authority_id';
  return sqliteJson<RiskRow>(
    dbPath,
    `SELECT single_offer_k, single_offer_n, single_offer_value_share,
            high_markup_k, high_markup_n, high_markup_value_share, contracts
     FROM ${table} WHERE ${col} = '${key}'`,
  )[0]!;
}

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'sigma-risk-rollups-'));
  dbPath = resolve(dir, 'test.sqlite');
  readScript(dbPath, schemaPath);
  readScript(dbPath, riskColumnsPath);
  sqlite(
    dbPath,
    `PRAGMA foreign_keys=ON;
INSERT INTO authorities (id, name, bulstat, type) VALUES ('auth:1', 'A', '100000001', 'public');
INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind)
  VALUES ('eik:1', 'B', '200000001', '200000001', 1, 'company');
INSERT INTO tenders (id, source_id, title, authority_id, estimated_value, currency, procedure_type, status)
  VALUES ('t:1', 'UNP-1', 'T', 'auth:1', 1000, 'EUR', 'open', 'awarded');
INSERT INTO contracts
  (id, tender_id, bidder_id, amount, currency, signing_value, current_value, value_flag, bids_received, amount_eur)
VALUES
  ('c:K1', 't:1', 'eik:1', 1000, 'EUR', 1000, 1000, 'ok',            1,    1000),
  ('c:K2', 't:1', 'eik:1', 2000, 'EUR', 1000, 1300, 'ok',            1,    2000),
  ('c:K3', 't:1', 'eik:1',  500, 'EUR', 1000, 1000, 'ok',            1,     500),
  ('c:K4', 't:1', 'eik:1', 6500, 'EUR', 1000, 1000, 'ok',            3,    6500),
  ('c:K5', 't:1', 'eik:1', 1000, 'EUR', 1000, 5000, 'value_suspect', NULL, 1000);
-- Adversarial (#229 review): a value_low contract carries a NEGATIVE amount_eur (normalize keeps
-- zero/negative rows in the sums). The value share must stay within [0,1] — proven by weighting only
-- positive amount_eur. eik:2 single-offer value share = 300 / (300 + 100) = 0.75, NOT (300-500)/(300-500+100).
INSERT INTO authorities (id, name, bulstat, type) VALUES ('auth:2', 'A2', '100000002', 'public');
INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind)
  VALUES ('eik:2', 'B2', '200000002', '200000002', 1, 'company');
INSERT INTO tenders (id, source_id, title, authority_id, estimated_value, currency, procedure_type, status)
  VALUES ('t:2', 'UNP-2', 'T2', 'auth:2', 1000, 'EUR', 'open', 'awarded');
INSERT INTO contracts
  (id, tender_id, bidder_id, amount, currency, signing_value, current_value, value_flag, bids_received, amount_eur)
VALUES
  ('c:V1', 't:2', 'eik:2',  300, 'EUR',  300,  300, 'ok',        1,  300),
  ('c:V2', 't:2', 'eik:2', -500, 'EUR', -500, -500, 'value_low', 1, -500),
  ('c:V3', 't:2', 'eik:2',  100, 'EUR',  100,  100, 'ok',        3,  100);`,
  );
  readScript(dbPath, precomputePath);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('per-subject risk aggregates (#229, precompute)', () => {
  it('counts single-offer contracts over the known-bid denominator (K of N)', () => {
    const r = riskRow('company_totals', 'eik:1');
    expect(r.single_offer_k).toBe(3);
    expect(r.single_offer_n).toBe(4);
  });

  it('weights the single-offer share by value, diverging from the count share', () => {
    // count share = 3/4 = 0.75; value share = 3500/10000 = 0.35 — deliberately different.
    expect(riskRow('company_totals', 'eik:1').single_offer_value_share).toBeCloseTo(0.35, 6);
  });

  it('excludes the value-suspect row from the high-markup denominator', () => {
    const r = riskRow('company_totals', 'eik:1');
    expect(r.high_markup_k).toBe(1);
    expect(r.high_markup_n).toBe(4);
  });

  it('weights the high-markup share by value', () => {
    expect(riskRow('company_totals', 'eik:1').high_markup_value_share).toBeCloseTo(0.2, 6);
  });

  it('excludes NULL-flag contracts from the risk denominators (n below contracts)', () => {
    const r = riskRow('company_totals', 'eik:1');
    expect(r.contracts).toBe(5);
    expect(r.single_offer_n).toBe(4);
    expect(r.high_markup_n).toBe(4);
  });

  it('produces identical aggregates on the authority side', () => {
    expect(riskRow('authority_totals', 'auth:1')).toEqual(riskRow('company_totals', 'eik:1'));
  });

  it('keeps the value share within [0,1] despite a negative value_low contract', () => {
    // Without the positive-money guard this is (300-500)/(300-500+100) = 2.0 — a 200% "share".
    expect(riskRow('company_totals', 'eik:2').single_offer_value_share).toBeCloseTo(0.75, 6);
  });

  it('is idempotent — a second precompute run yields the same aggregates', () => {
    const before = riskRow('company_totals', 'eik:1');
    readScript(dbPath, precomputePath);
    expect(riskRow('company_totals', 'eik:1')).toEqual(before);
  });
});
