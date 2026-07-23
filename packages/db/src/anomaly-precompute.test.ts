/// <reference types="node" />
// Behavioural tests for the anomaly derive/scoring SQL (scripts/precompute.sql §7) against a real
// SQLite database: a tiny seeded corpus exercises each signal's threshold, the framework exclusion
// and the qualifying-row rule, then §7 runs verbatim from the repo file. Complements
// anomaly-parity.test.ts (which pins the refresh-slice copy to this exact block). Requires the
// sqlite3 CLI (devcontainer/CI), like the other *.sql-driven suites.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = resolve(root, 'packages/db/migrations');
const precomputePath = resolve(root, 'scripts/precompute.sql');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', ['-bail', dbPath], { input: sql, encoding: 'utf8' });
}

function sqliteJson<T>(dbPath: string, sql: string): T[] {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
  return out ? (JSON.parse(out) as T[]) : [];
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
}

/** §7 of precompute.sql — the anomaly build — exactly as shipped. */
function anomalySection(): string {
  const sql = readFileSync(precomputePath, 'utf8');
  const start = sql.indexOf('-- ── 7) Anomaly screen');
  const end = sql.indexOf('-- Summary (last result set');
  if (start === -1 || end === -1 || end <= start)
    throw new Error('precompute.sql §7 markers not found');
  return sql.slice(start, end);
}

// One authority/bidder; per-case tenders+contracts. Peer cohort 45233120: eleven 10 000 € contracts
// + one 120 000 € outlier (the cohort median intentionally includes the outlier itself — n=12, the
// middle pair stays 10 000). The other cases use unique CPV codes so peers < 10 keeps ratio NULL.
const BASE_SEED = `
INSERT INTO authorities (id, name) VALUES ('auth:100', 'Тест Възложител');
INSERT INTO bidders (id, name) VALUES ('eik:200', 'Тест ООД');
`;

const SEED = `
-- over-estimate ≥3× + single bid in a competitive procedure → 45 + 10 = 55
INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, estimated_value, currency, procedure_type)
VALUES ('t:13', 'UNP-13', 'Служба по чистота', 'auth:100', '90911200', 100000, 'BGN', 'Открита процедура');
INSERT INTO contracts (id, tender_id, bidder_id, amount, amount_eur, signing_value_eur, bids_received, signed_at, value_flag)
VALUES ('c:13', 't:13', 'eik:200', 312933, 160000, 160000, 1, '2024-05-01', 'ok');

-- annex growth ≥1.5× + no-notice procedure → 30 + 5 = 35
INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type)
VALUES ('t:14', 'UNP-14', 'Правни услуги', 'auth:100', '79111000', 'Пряко договаряне');
INSERT INTO contracts (id, tender_id, bidder_id, amount, amount_eur, signing_value_eur, current_value_eur, annex_count, signed_at, value_flag)
VALUES ('c:14', 't:14', 'eik:200', 195583, 100000, 100000, 160000, 1, '2024-06-01', 'ok');

-- framework/DPS: two awards on a single-lot tender → the estimate is a ceiling, MUST NOT flag
INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, estimated_value, currency, procedure_type)
VALUES ('t:15', 'UNP-15', 'Хотелско настаняване', 'auth:100', '55100000', 1000, 'BGN', 'Открита процедура');
INSERT INTO contracts (id, tender_id, bidder_id, amount, amount_eur, signing_value_eur, signed_at, value_flag)
VALUES ('c:15a', 't:15', 'eik:200', 97792, 50000, 50000, '2024-07-01', 'ok'),
       ('c:15b', 't:15', 'eik:200', 97792, 50000, 50000, '2024-07-01', 'ok');

-- context-only single bid, no price signal → MUST NOT create a row
INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type)
VALUES ('t:16', 'UNP-16', 'Градски превоз', 'auth:100', '60100000', 'Публично състезание');
INSERT INTO contracts (id, tender_id, bidder_id, amount, amount_eur, bids_received, signed_at, value_flag)
VALUES ('c:16', 't:16', 'eik:200', 39117, 20000, 1, '2024-08-01', 'ok');
`;

function peerCohortSeed(): string {
  const rows: string[] = [];
  for (let i = 1; i <= 11; i += 1) {
    rows.push(`
INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type)
VALUES ('t:${i}', 'UNP-${i}', 'Пътна маркировка ${i}', 'auth:100', '45233120', 'Открита процедура');
INSERT INTO contracts (id, tender_id, bidder_id, amount, amount_eur, bids_received, signed_at, value_flag)
VALUES ('c:${i}', 't:${i}', 'eik:200', 19558, 10000, 3, '2024-01-0${(i % 9) + 1}', 'ok');`);
  }
  rows.push(`
INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type)
VALUES ('t:12', 'UNP-12', 'Пътна маркировка 12', 'auth:100', '45233120', 'Открита процедура');
INSERT INTO contracts (id, tender_id, bidder_id, amount, amount_eur, bids_received, signed_at, value_flag)
VALUES ('c:12', 't:12', 'eik:200', 234700, 120000, 3, '2024-02-01', 'ok');`);
  return rows.join('\n');
}

interface AnomalyRow {
  contract_id: string;
  score: number;
  flag_over_estimate: number;
  flag_annex_growth: number;
  flag_price_outlier: number;
  flag_single_bid: number;
  flag_no_notice: number;
  over_estimate_ratio: number | null;
  estimated_eur: number | null;
  annex_growth_ratio: number | null;
  price_ratio: number | null;
  peer_median_eur: number | null;
  peer_count: number | null;
  cpv_division: string | null;
}

describe('anomaly precompute (§7) behaviour', () => {
  let dir: string;
  let dbPath: string;
  const rowsById = new Map<string, AnomalyRow>();

  beforeAll(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'sigma-anomaly-'));
    dbPath = resolve(dir, 'test.sqlite');
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort())
      readScript(dbPath, resolve(migrationsDir, file));
    sqlite(dbPath, BASE_SEED);
    sqlite(dbPath, peerCohortSeed());
    sqlite(dbPath, SEED);
    const sectionPath = resolve(dir, 'section7.sql');
    writeFileSync(sectionPath, anomalySection(), 'utf8');
    readScript(dbPath, sectionPath);
    for (const row of sqliteJson<AnomalyRow>(dbPath, 'SELECT * FROM contract_anomalies'))
      rowsById.set(row.contract_id, row);
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it('computes the cohort median over the full CPV code, including the contract itself', () => {
    const stats = sqliteJson<{ peers: number; median_eur: number }>(
      dbPath,
      "SELECT peers, median_eur FROM cpv_price_stats WHERE cpv_code = '45233120'",
    );
    expect(stats).toEqual([{ peers: 12, median_eur: 10000 }]);
  });

  it('flags a ≥10× price outlier at 25 points with the peer evidence stored', () => {
    const row = rowsById.get('c:12')!;
    expect(row).toMatchObject({
      score: 25,
      flag_price_outlier: 1,
      flag_over_estimate: 0,
      flag_annex_growth: 0,
      flag_single_bid: 0,
      flag_no_notice: 0,
      price_ratio: 12,
      peer_median_eur: 10000,
      peer_count: 12,
      cpv_division: '45',
    });
  });

  it('does not flag the 10 000 € cohort peers (ratio 1, under every floor)', () => {
    for (let i = 1; i <= 11; i += 1) expect(rowsById.has(`c:${i}`)).toBe(false);
  });

  it('flags ≥3× over the own estimate at 45 points, plus 10 for the single bid', () => {
    const row = rowsById.get('c:13')!;
    expect(row).toMatchObject({ score: 55, flag_over_estimate: 1, flag_single_bid: 1 });
    // est 100 000 BGN → 51 129.55 € at the peg; 160 000 / 51 129.55 ≈ 3.13 (≥ 3 → the 45 tier).
    expect(row.estimated_eur!).toBeCloseTo(100000 / 1.95583, 2);
    expect(row.over_estimate_ratio!).toBeGreaterThanOrEqual(3);
    expect(row.price_ratio).toBeNull(); // peers < 10 → no cohort comparison
  });

  it('flags ≥1.5× annex growth at 30 points, plus 5 for the no-notice procedure', () => {
    const row = rowsById.get('c:14')!;
    expect(row).toMatchObject({ score: 35, flag_annex_growth: 1, flag_no_notice: 1 });
    expect(row.annex_growth_ratio!).toBeCloseTo(1.6, 6);
  });

  it('excludes framework/DPS call-offs from the estimate comparison (awards > lots)', () => {
    expect(rowsById.has('c:15a')).toBe(false);
    expect(rowsById.has('c:15b')).toBe(false);
  });

  it('never creates a row from context signals alone', () => {
    expect(rowsById.has('c:16')).toBe(false);
  });
});
