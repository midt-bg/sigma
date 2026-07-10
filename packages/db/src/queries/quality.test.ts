/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  coverageTier,
  getQuality,
  getQualityScorecard,
  getQualitySummary,
  qualityBlend,
} from './quality';

// Integration test for the /quality query module. Unlike competition.test.ts's canned-row fake D1,
// the quality tables (contract_features + the six *_quality_totals rollups) are NEW — so this builds
// a real SQLite (node:sqlite; the sqlite3 CLI harness of competition-sql.test.ts is not guaranteed
// on every dev box) from the production migration PLUS the exact DDL of scripts/
// derive-contract-features.sql, loads a deterministic fixture, and runs the actual module SQL + JS
// mapping against it. The D1 adapter below is the minimal prepare/bind/all/first surface the module
// uses.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

// DDL copied verbatim from scripts/derive-contract-features.sql (the ETL owns those files; this test
// only mirrors the shape it will read in production).
const QUALITY_DDL = `
CREATE TABLE contract_features (
  contract_id TEXT PRIMARY KEY REFERENCES contracts(id),
  effective_peer_key TEXT, peer_n INTEGER,
  coverage_bids INTEGER, coverage_sme INTEGER, coverage_estimate INTEGER,
  coverage_overrun INTEGER, coverage_ocds INTEGER, score_coverage REAL,
  bids_received INTEGER, single_offer INTEGER, sme_rate REAL, disq_rate REAL,
  is_open_procedure INTEGER, is_direct_award INTEGER, has_exemption INTEGER,
  is_outside_zop INTEGER, is_dps INTEGER, is_meat INTEGER, is_accelerated INTEGER,
  is_framework INTEGER, is_eauction INTEGER, bid_window_days REAL, scoring_regime TEXT,
  annex_count INTEGER, cost_overrun_ratio REAL, estimate_dev_ratio REAL,
  value_flag TEXT, has_reason_text INTEGER, first_amend_shock INTEGER,
  authority_hhi REAL, bidder_buyer_hhi REAL, repeat_win_intensity REAL,
  sector_win_share REAL, pair_first_date TEXT, edge_age_years REAL, authority_suppliers INTEGER,
  date_flag TEXT, eu_funded INTEGER, subcontract_passthrough REAL, corrections_count INTEGER,
  duration_days INTEGER, winner_size TEXT, bidder_nuts TEXT, awarded_to_group INTEGER,
  score_a REAL, score_b REAL, score_c REAL, score_d REAL, score_e REAL,
  score_overall REAL, computed_at TEXT,
  score_a_bids REAL, peer_has_multi INTEGER
);
CREATE TABLE authority_quality_totals (
  authority_id TEXT PRIMARY KEY REFERENCES authorities(id), name TEXT NOT NULL, type_group TEXT,
  avg_overall REAL, avg_a REAL, avg_b REAL, avg_c REAL, avg_d REAL, avg_e REAL,
  total_contracts INTEGER NOT NULL, scored_contracts INTEGER NOT NULL, unknown_contracts INTEGER,
  single_offer_count INTEGER, direct_award_count INTEGER, amended_count INTEGER,
  mean_coverage REAL, computed_at TEXT
);
CREATE TABLE bidder_quality_totals (
  bidder_id TEXT PRIMARY KEY REFERENCES bidders(id), name TEXT NOT NULL,
  avg_overall REAL, avg_c REAL, avg_d REAL, buyer_hhi REAL,
  total_contracts INTEGER NOT NULL, scored_contracts INTEGER NOT NULL, amended_count INTEGER,
  mean_coverage REAL, computed_at TEXT
);
CREATE TABLE sector_quality_totals (
  division TEXT PRIMARY KEY, avg_overall REAL, avg_a REAL, avg_c REAL,
  total_contracts INTEGER NOT NULL, scored_contracts INTEGER, single_offer_pct REAL,
  direct_award_pct REAL, mean_coverage REAL, computed_at TEXT
);
CREATE TABLE region_quality_totals (
  nuts TEXT PRIMARY KEY, nuts_label TEXT, avg_overall REAL,
  total_contracts INTEGER NOT NULL, scored_contracts INTEGER, mean_coverage REAL, computed_at TEXT
);
CREATE TABLE year_quality_totals (
  year TEXT PRIMARY KEY, avg_overall REAL, avg_a REAL, avg_b REAL, avg_c REAL, avg_d REAL, avg_e REAL,
  total_contracts INTEGER NOT NULL, scored_contracts INTEGER, mean_coverage REAL, computed_at TEXT
);
CREATE TABLE funding_quality_totals (
  funding_key TEXT PRIMARY KEY,
  avg_overall REAL, total_contracts INTEGER NOT NULL, scored_contracts INTEGER,
  mean_coverage REAL, computed_at TEXT
);
`;

// Two authorities, two suppliers, four contracts:
//  c:1  weak   (auth:100000001 × eik:200000001, 45): pillars .2/.4/.55/.3/.84 → wmean .4015, worst .2 → overall .321
//  c:2  strong (auth:100000002 × eik:200000002, 33): pillars .8/.9/.9/.7/1.0  → wmean .84,   worst .7 → overall .784
//  c:4  mid    (auth:100000002 × eik:200000001, 33, EU): pillars .5/.6/.7/.5/.9 → wmean .605, worst .5 → overall .563
//  c:3  value_suspect (auth:100000001 × eik:200000002): all scores NULL — must surface as unscored, never as 0.
const FIXTURE = `
INSERT INTO authorities (id, name, bulstat, type_group) VALUES
  ('auth:100000001', 'Институция А', '100000001', 'община'),
  ('auth:100000002', 'Институция Б', '100000002', 'болница');
INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
  ('eik:200000001', 'Фирма Х', '200000001', '200000001', 1, 'company'),
  ('eik:200000002', 'Фирма У', '200000002', '200000002', 1, 'company');
INSERT INTO tenders (id, source_id, title, authority_id, cpv_code, procedure_type, status, place_of_performance) VALUES
  ('t:A', 'UNP-A', 'Поръчка А', 'auth:100000001', '45233120', 'Открита процедура', 'awarded', 'BG411'),
  ('t:B', 'UNP-B', 'Поръчка Б', 'auth:100000002', '33600000', 'Публично състезание', 'awarded', 'BG421');
INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, bids_received, eu_funded, value_flag, amount_eur) VALUES
  ('c:1', 't:A', 'eik:200000001', 1000, 'EUR', '2024-03-01', 1, 0, 'ok', 1000),
  ('c:2', 't:B', 'eik:200000002', 2000, 'EUR', '2025-06-01', 4, 0, 'ok', 2000),
  ('c:3', 't:A', 'eik:200000002', 99999999, 'BGN', '2024-05-01', 1, 0, 'value_suspect', NULL),
  ('c:4', 't:B', 'eik:200000001', 1500, 'EUR', '2024-09-01', 2, 1, 'ok', 1500);
INSERT INTO contract_features (
  contract_id, score_coverage, value_flag,
  score_a, score_b, score_c, score_d, score_e, score_overall,
  bids_received, single_offer, sme_rate, is_eauction, is_accelerated, bid_window_days,
  annex_count, cost_overrun_ratio, estimate_dev_ratio, first_amend_shock,
  authority_hhi, repeat_win_intensity, edge_age_years, sector_win_share,
  date_flag, subcontract_passthrough, duration_days, corrections_count,
  coverage_bids, coverage_sme, coverage_estimate, coverage_overrun
) VALUES
  ('c:1', 0.78, 'ok', 0.2, 0.4, 0.55, 0.3, 0.84, 0.321,
   1, 1, NULL, 0, 0, 22, 2, 1.4, 0.35, 0,
   0.74, 0.71, 9.0, 0.4, 'ok', NULL, 720, NULL, 1, 0, 1, 1),
  ('c:2', 0.85, 'ok', 0.8, 0.9, 0.9, 0.7, 1.0, 0.784,
   4, 0, 0.5, 1, 0, 35, 0, 1.0, 0.04, 0,
   0.22, 0.19, 1.2, 0.1, 'ok', NULL, 365, NULL, 1, 1, 1, 1),
  ('c:3', 0.30, 'value_suspect', NULL, NULL, NULL, NULL, NULL, NULL,
   1, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   0.74, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, 0, 0, 0),
  ('c:4', 0.50, 'ok', 0.5, 0.6, 0.7, 0.5, 0.9, 0.563,
   2, 0, 0.5, 0, 0, 30, 1, 1.1, 0.2, 0,
   0.22, 0.42, 4.0, 0.2, 'ok', NULL, 400, NULL, 1, 1, 1, 1);
-- Rollups as the ETL would write them (scored_contracts inflated past the module's authority/
-- supplier small-sample floor so the ranking queries return the fixture rows).
INSERT INTO authority_quality_totals VALUES
  ('auth:100000001', 'Институция А', 'община', 0.321, 0.2, 0.4, 0.55, 0.3, 0.84, 40, 25, 15, 30, 5, 10, 0.78, '2026-07-01'),
  ('auth:100000002', 'Институция Б', 'болница', 0.690, 0.68, 0.78, 0.82, 0.62, 0.96, 60, 50, 10, 5, 1, 8, 0.85, '2026-07-01');
INSERT INTO bidder_quality_totals VALUES
  ('eik:200000001', 'Фирма Х', 0.40, 0.60, 0.38, 0.5, 45, 30, 12, 0.66, '2026-07-01'),
  ('eik:200000002', 'Фирма У', 0.784, 0.9, 0.7, 0.2, 30, 25, 2, 0.85, '2026-07-01');
INSERT INTO sector_quality_totals VALUES
  ('45', 0.42, 0.3, 0.5, 100, 80, 41.0, 12.0, 0.74, '2026-07-01'),
  ('33', 0.66, 0.6, 0.8, 90, 85, 20.0, 5.0, 0.82, '2026-07-01'),
  ('NA', 0.5, 0.5, 0.5, 10, 5, 0, 0, 0.5, '2026-07-01');
INSERT INTO region_quality_totals VALUES
  ('BG411', 'София (столица)', 0.61, 120, 100, 0.84, '2026-07-01'),
  ('BG421', 'Пловдив', 0.64, 60, 55, 0.83, '2026-07-01'),
  ('NA', NULL, 0.5, 9, 4, 0.4, '2026-07-01');
INSERT INTO year_quality_totals VALUES
  ('2024', 0.44, 0.35, 0.5, 0.62, 0.4, 0.72, 90, 70, 0.58, '2026-07-01'),
  ('2025', 0.63, 0.6, 0.7, 0.84, 0.62, 0.9, 100, 95, 0.9, '2026-07-01'),
  ('NA', 0.5, NULL, NULL, NULL, NULL, NULL, 3, 1, 0.4, '2026-07-01');
INSERT INTO funding_quality_totals VALUES
  ('eu', 0.54, 44164, 40000, 0.82, '2026-07-01'),
  ('national', 0.60, 150320, 140000, 0.85, '2026-07-01');
`;

/**
 * Extracts the column names a `CREATE TABLE [IF NOT EXISTS] <name> (...)` statement declares, from
 * raw SQL text — paren-depth aware (so `REFERENCES foo(id)` and similar don't split the column
 * list early), comments stripped, table-level constraints (PRIMARY/FOREIGN/UNIQUE/CHECK/CONSTRAINT)
 * excluded. Used by the schema-drift guard below to compare QUALITY_DDL against the real DDL in
 * scripts/derive-contract-features.sql without executing either.
 */
function extractTableColumns(sql: string, table: string): string[] {
  const noComments = sql.replace(/--[^\n]*/g, '');
  const start = noComments.search(
    new RegExp(`CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?${table}\\s*\\(`, 'i'),
  );
  if (start === -1) throw new Error(`CREATE TABLE ${table} not found`);
  const openParen = noComments.indexOf('(', start);
  let depth = 0;
  let end = openParen;
  for (let i = openParen; i < noComments.length; i += 1) {
    if (noComments[i] === '(') depth += 1;
    else if (noComments[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = noComments.slice(openParen + 1, end);
  // Split on top-level commas only (depth-0), so REFERENCES foo(id) stays inside one column entry.
  const parts: string[] = [];
  let depth2 = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth2 += 1;
    else if (ch === ')') depth2 -= 1;
    if (ch === ',' && depth2 === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  const constraintKeywords = new Set(['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT']);
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => p.split(/\s+/)[0]!)
    .filter((name) => !constraintKeywords.has(name.toUpperCase()));
}

/** Minimal D1 surface over node:sqlite — enough for the module's prepare().bind().all()/first(). */
function asD1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let args: (string | number | null)[] = [];
      const stmt = {
        bind(...a: (string | number | null)[]) {
          args = a;
          return stmt;
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...args) as T[] };
        },
        async first<T>() {
          return (db.prepare(sql).get(...args) ?? null) as T | null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

let d1: D1Database;

beforeAll(() => {
  const db = new DatabaseSync(':memory:');
  // Full migration chain — the fixture writes 0003's health-index columns.
  const migrationsDir = resolve(root, 'packages/db/migrations');
  for (const f of readdirSync(migrationsDir)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(resolve(migrationsDir, f), 'utf8'));
  }
  // 0000_init ships the quality tables too; drop them so QUALITY_DDL (the ETL-derive shape this
  // test mirrors verbatim) is the single source of the schema under test.
  for (const t of [
    'contract_features',
    'authority_quality_totals',
    'bidder_quality_totals',
    'sector_quality_totals',
    'region_quality_totals',
    'year_quality_totals',
    'funding_quality_totals',
  ]) {
    db.exec(`DROP TABLE IF EXISTS ${t};`);
  }
  db.exec(QUALITY_DDL);
  db.exec(FIXTURE);
  d1 = asD1(db);
});

// Schema-drift guard: QUALITY_DDL above is a third hand-copy of the quality schema (besides
// 0000_init.sql and scripts/derive-contract-features.sql). Rather than trust it by eyeball, diff its
// column set against the real ETL DDL it's supposed to mirror for every quality table — so a future
// column added to one and not the other fails CI instead of silently drifting.
describe('QUALITY_DDL schema-drift guard', () => {
  const etlSql = readFileSync(resolve(root, 'scripts/derive-contract-features.sql'), 'utf8');
  const tables = [
    'contract_features',
    'authority_quality_totals',
    'bidder_quality_totals',
    'sector_quality_totals',
    'region_quality_totals',
    'year_quality_totals',
    'funding_quality_totals',
  ];

  it.each(tables)('%s columns match scripts/derive-contract-features.sql exactly', (table) => {
    const testCols = extractTableColumns(QUALITY_DDL, table).sort();
    const etlCols = extractTableColumns(etlSql, table).sort();
    expect(testCols).toEqual(etlCols);
  });
});

describe('coverageTier', () => {
  it('maps §6.2 thresholds; null/withheld → none, never a fabricated low tier', () => {
    expect(coverageTier(0.9)).toBe('high');
    expect(coverageTier(0.8)).toBe('high');
    expect(coverageTier(0.79)).toBe('medium');
    expect(coverageTier(0.6)).toBe('medium');
    expect(coverageTier(0.59)).toBe('low');
    expect(coverageTier(0.4)).toBe('low');
    expect(coverageTier(0.39)).toBe('none');
    expect(coverageTier(null)).toBe('none');
  });
});

describe('qualityBlend', () => {
  it('renormalizes weights over non-NULL pillars and finds the worst link', () => {
    const b = qualityBlend({ a: 0.2, b: 0.4, c: 0.55, d: 0.3, e: 0.84 });
    expect(b.wmean).toBeCloseTo(0.4015, 4);
    expect(b.worst).toBe(0.2);
    expect(b.worstPillar).toBe('a');
    // 0.6 × wmean + 0.4 × worst reproduces the ETL's stored score_overall
    expect(0.6 * b.wmean! + 0.4 * b.worst!).toBeCloseTo(0.321, 3);
  });

  it('drops NULL pillars and renormalizes to sum 1 (spec §3.3 step 3)', () => {
    const b = qualityBlend({ a: 0.5, b: null, c: 0.5, d: null, e: null });
    // weights a=.30, c=.25 → renormalized .5455/.4545
    expect(b.effectiveWeights.a).toBeCloseTo(0.3 / 0.55, 4);
    expect(b.effectiveWeights.c).toBeCloseTo(0.25 / 0.55, 4);
    expect(b.effectiveWeights.b).toBeNull();
    expect(b.wmean).toBeCloseTo(0.5, 6);
  });

  it('returns all-null for a fully unscored contract — unknown, not zero', () => {
    const b = qualityBlend({ a: null, b: null, c: null, d: null, e: null });
    expect(b.wmean).toBeNull();
    expect(b.worst).toBeNull();
    expect(b.worstPillar).toBeNull();
  });
});

describe('getQuality — overview', () => {
  it('counts total/scored/suspect and averages only scored rows', async () => {
    const { overview } = await getQuality(d1, {});
    expect(overview.totalContracts).toBe(4);
    expect(overview.scoredContracts).toBe(3);
    expect(overview.suspectContracts).toBe(1);
    // mean of .321/.784/.563 — the NULL row never drags this toward 0
    expect(overview.avgOverall).toBeCloseTo((0.321 + 0.784 + 0.563) / 3, 6);
    expect(overview.pillars.a).toBeCloseTo((0.2 + 0.8 + 0.5) / 3, 6);
  });

  it('builds the 20-bin histogram over scored contracts only', async () => {
    const { overview } = await getQuality(d1, {});
    const byBin = new Map(overview.histogram.map((b) => [b.bin, b.count]));
    expect(byBin.get(6)).toBe(1); // .321
    expect(byBin.get(11)).toBe(1); // .563
    expect(byBin.get(15)).toBe(1); // .784
    expect(overview.histogram.reduce((t, b) => t + b.count, 0)).toBe(3);
  });

  it('tiers the confidence mix and buckets unscored rows as „няма оценка"', async () => {
    const { overview } = await getQuality(d1, {});
    expect(overview.confidence).toEqual({ high: 1, medium: 1, low: 1, none: 1 });
  });
});

describe('getQuality — ranking', () => {
  it('ranks authorities weakest-first with slug hrefs, type labels and coverage tiers', async () => {
    const { ranking } = await getQuality(d1, { grain: 'authority' });
    expect(ranking.map((r) => r.key)).toEqual(['auth:100000001', 'auth:100000002']);
    expect(ranking[0]).toMatchObject({
      href: '/authorities/100000001',
      name: 'Институция А',
      sub: 'община',
      avgOverall: 0.321,
      coverageTier: 'medium',
    });
    expect(ranking[0]!.pillars).toEqual({ a: 0.2, b: 0.4, c: 0.55, d: 0.3, e: 0.84 });
  });

  it('sorts by volume when asked', async () => {
    const { ranking } = await getQuality(d1, { grain: 'authority', sort: 'contracts' });
    expect(ranking.map((r) => r.key)).toEqual(['auth:100000002', 'auth:100000001']);
  });

  it('labels sectors from the CPV config and drops the NA bucket', async () => {
    const { ranking } = await getQuality(d1, { grain: 'sector' });
    expect(ranking.map((r) => r.key)).toEqual(['45', '33']);
    expect(ranking[0]!.name.startsWith('45 · ')).toBe(true);
    // sector rollup only carries A and C averages — the others stay null, not 0
    expect(ranking[0]!.pillars).toEqual({ a: 0.3, b: null, c: 0.5, d: null, e: null });
  });

  it('serves region, year and funding grains with their labels', async () => {
    const region = await getQuality(d1, { grain: 'region' });
    expect(region.ranking.map((r) => r.key)).toEqual(['BG411', 'BG421']);
    expect(region.ranking[0]!.name).toBe('София (столица)');

    const year = await getQuality(d1, { grain: 'year' });
    expect(year.ranking.map((r) => r.key)).toEqual(['2024', '2025']);

    const funding = await getQuality(d1, { grain: 'funding' });
    expect(funding.ranking.map((r) => r.key)).toEqual(['eu', 'national']);
    expect(funding.ranking[0]!.name).toBe('Европейско финансиране');
  });

  it('links suppliers to their company pages', async () => {
    const { ranking } = await getQuality(d1, { grain: 'supplier' });
    expect(ranking[0]).toMatchObject({ key: 'eik:200000001', href: '/companies/200000001' });
  });
});

describe('getQuality — ranking direction', () => {
  it('flips the score sort to best-first on dir=desc (exact first row both ways)', async () => {
    const asc = await getQuality(d1, { grain: 'authority' });
    expect(asc.ranking.map((r) => r.key)).toEqual(['auth:100000001', 'auth:100000002']);
    expect(asc.scope.sortDir).toBe('asc'); // score defaults to weakest-first

    const desc = await getQuality(d1, { grain: 'authority', dir: 'desc' });
    expect(desc.ranking.map((r) => r.key)).toEqual(['auth:100000002', 'auth:100000001']);
    expect(desc.ranking[0]!.avgOverall).toBe(0.69);
    expect(desc.scope.sortDir).toBe('desc');
  });

  it('flips the contracts sort to fewest-first on dir=asc', async () => {
    const desc = await getQuality(d1, { grain: 'authority', sort: 'contracts' });
    expect(desc.ranking.map((r) => r.key)).toEqual(['auth:100000002', 'auth:100000001']);
    expect(desc.scope.sortDir).toBe('desc'); // contracts defaults to biggest-first

    const asc = await getQuality(d1, { grain: 'authority', sort: 'contracts', dir: 'asc' });
    expect(asc.ranking.map((r) => r.key)).toEqual(['auth:100000001', 'auth:100000002']);
  });

  it('drops a malformed dir at the query boundary — default order, never raw SQL', async () => {
    const r = await getQuality(d1, { grain: 'authority', dir: 'up; DROP TABLE x' as never });
    expect(r.ranking.map((x) => x.key)).toEqual(['auth:100000001', 'auth:100000002']);
    expect(r.scope.sortDir).toBe('asc');
  });
});

describe('getQuality — ranking avg-index range (?rfrom/?rto)', () => {
  // Authority rollup avg_overall: А 0.321 · Б 0.690 (display 32 and 69 on the 0–100 scale).
  it('narrows the rollup to rows inside [from, to] with exact row counts', async () => {
    const low = await getQuality(d1, { grain: 'authority', rankFrom: 0, rankTo: 50 });
    expect(low.ranking.map((r) => r.key)).toEqual(['auth:100000001']);

    const high = await getQuality(d1, { grain: 'authority', rankFrom: 35, rankTo: 100 });
    expect(high.ranking.map((r) => r.key)).toEqual(['auth:100000002']);

    const all = await getQuality(d1, { grain: 'authority', rankFrom: 0, rankTo: 100 });
    expect(all.ranking).toHaveLength(2);
  });

  it('keeps both bounds inclusive — from=to pins rows sitting exactly on the boundary', async () => {
    const pin = await getQuality(d1, { grain: 'authority', rankFrom: 69, rankTo: 69 });
    expect(pin.ranking.map((r) => r.key)).toEqual(['auth:100000002']); // avg 0.690 = 69/100

    const empty = await getQuality(d1, { grain: 'authority', rankFrom: 68, rankTo: 68 });
    expect(empty.ranking).toEqual([]);
  });

  it('supports one-sided ranges and swaps an inverted pair', async () => {
    const from = await getQuality(d1, { grain: 'authority', rankFrom: 50 });
    expect(from.ranking.map((r) => r.key)).toEqual(['auth:100000002']);

    const to = await getQuality(d1, { grain: 'authority', rankTo: 50 });
    expect(to.ranking.map((r) => r.key)).toEqual(['auth:100000001']);

    const swapped = await getQuality(d1, { grain: 'authority', rankFrom: 50, rankTo: 0 });
    expect(swapped.ranking.map((r) => r.key)).toEqual(['auth:100000001']);
    expect(swapped.scope.rankFrom).toBe(0);
    expect(swapped.scope.rankTo).toBe(50);
  });

  it('filters the other grains too (year rollup)', async () => {
    const y = await getQuality(d1, { grain: 'year', rankFrom: 60, rankTo: 100 });
    expect(y.ranking.map((r) => r.key)).toEqual(['2025']); // avg 0.63; 2024 (0.44) is out
  });

  it('drops malformed bounds at the query boundary — non-int / out-of-range never reach SQL', async () => {
    for (const bad of [-5, 101, 3.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = await getQuality(d1, { grain: 'authority', rankFrom: bad, rankTo: bad });
      expect(r.scope.rankFrom).toBeNull();
      expect(r.scope.rankTo).toBeNull();
      expect(r.ranking).toHaveLength(2); // unfiltered — the bogus bound was dropped, not clamped
    }
    const str = await getQuality(d1, { grain: 'authority', rankFrom: '10; --' as never });
    expect(str.scope.rankFrom).toBeNull();
    expect(str.ranking).toHaveLength(2);
  });

  it('composes with sort and direction', async () => {
    const r = await getQuality(d1, {
      grain: 'authority',
      sort: 'contracts',
      dir: 'asc',
      rankFrom: 0,
      rankTo: 50,
    });
    expect(r.ranking.map((x) => x.key)).toEqual(['auth:100000001']); // range ∧ fewest-first
  });
});

describe('getQuality — contracts list & scoping', () => {
  it('lists scored contracts weakest-first, unscored value_suspect rows last (never as 0)', async () => {
    const { contracts } = await getQuality(d1, {});
    expect(contracts.map((c) => c.id)).toEqual(['c:1', 'c:4', 'c:2', 'c:3']);
    const suspect = contracts[3]!;
    expect(suspect.overall).toBeNull();
    expect(suspect.valueFlag).toBe('value_suspect');
    expect(suspect.coverageTier).toBe('none');
  });

  it('sorts by value when asked (NULL-value suspect rows sink)', async () => {
    const { contracts } = await getQuality(d1, { contractSort: 'value' });
    expect(contracts.map((c) => c.id)).toEqual(['c:2', 'c:4', 'c:1', 'c:3']);
  });

  it('scopes the list to a selected authority', async () => {
    const { contracts } = await getQuality(d1, { grain: 'authority', sel: 'auth:100000001' });
    expect(contracts.map((c) => c.id)).toEqual(['c:1', 'c:3']);
  });

  it('scopes by sector, year and funding', async () => {
    const sector = await getQuality(d1, { grain: 'sector', sel: '33' });
    expect(sector.contracts.map((c) => c.id)).toEqual(['c:4', 'c:2']);

    const year = await getQuality(d1, { grain: 'year', sel: '2025' });
    expect(year.contracts.map((c) => c.id)).toEqual(['c:2']);

    const eu = await getQuality(d1, { grain: 'funding', sel: 'eu' });
    expect(eu.contracts.map((c) => c.id)).toEqual(['c:4']);
  });

  it('defaults the scorecard to the weakest listed contract', async () => {
    const { scorecard } = await getQuality(d1, {});
    expect(scorecard?.id).toBe('c:1');
  });

  it('keeps scope.contractId null when no ?contract was requested — an auto-picked default must not get baked into preserved links', async () => {
    const auto = await getQuality(d1, {});
    expect(auto.scorecard?.id).toBe('c:1'); // auto-picked for display
    expect(auto.scope.contractId).toBeNull(); // but not echoed back as "the" selection

    const explicit = await getQuality(d1, { contractId: 'c:2' });
    expect(explicit.scorecard?.id).toBe('c:2');
    expect(explicit.scope.contractId).toBe('c:2'); // explicit ?contract IS preserved
  });

  it('score-band filter narrows to the exact histogram bin (bounds match the overview bins)', async () => {
    // Overall scores: c:1 .321 → bin 6 [.30,.35) · c:4 .563 → bin 11 [.55,.60) · c:2 .784 → bin 15.
    const bin6 = await getQuality(d1, { band: '6' });
    expect(bin6.contracts.map((c) => c.id)).toEqual(['c:1']);

    const bin11 = await getQuality(d1, { band: '11' });
    expect(bin11.contracts.map((c) => c.id)).toEqual(['c:4']);

    // Adjacent empty bin: honest empty set, and the unscored c:3 never leaks into any band.
    const bin7 = await getQuality(d1, { band: '7' });
    expect(bin7.contracts).toEqual([]);

    // Top bin closes at 1.0 inclusive (mirrors the `>= 1.0 → 19` histogram clause).
    const bin19 = await getQuality(d1, { band: '19' });
    expect(bin19.contracts).toEqual([]);
  });

  it('named zone bands map to the page zones: weak [0,.5) · mid [.5,.7) · good [.7,1]', async () => {
    const byBand = async (band: string) =>
      (await getQuality(d1, { band })).contracts.map((c) => c.id);
    expect(await byBand('weak')).toEqual(['c:1']); // .321
    expect(await byBand('mid')).toEqual(['c:4']); // .563
    expect(await byBand('good')).toEqual(['c:2']); // .784
  });

  it('band composes with the sel scope (AND) and malformed values never reach SQL', async () => {
    // sel (authority Б → c:2, c:4) ∧ band=good → only c:2.
    const scoped = await getQuality(d1, {
      grain: 'authority',
      sel: 'auth:100000002',
      band: 'good',
    });
    expect(scoped.contracts.map((c) => c.id)).toEqual(['c:2']);
    expect(scoped.scope.band).toBe('good');

    // Malformed shapes: out-of-range, negative, fractional, SQL-ish, wrong name — all dropped.
    for (const band of ['20', '-1', '1.5', '6 OR 1=1', 'strong', '']) {
      const r = await getQuality(d1, { band });
      expect(r.scope.band).toBeNull();
      expect(r.contracts).toHaveLength(4); // unfiltered — the bogus value never reached a WHERE
    }
  });
});

describe('getQualityScorecard', () => {
  it('reproduces the ETL blend and maps the raw leaves', async () => {
    const card = await getQualityScorecard(d1, 'c:1');
    expect(card).not.toBeNull();
    expect(card!.known).toBe(true);
    expect(card!.overall).toBe(0.321);
    expect(card!.wmean).toBeCloseTo(0.4015, 4);
    expect(card!.worst).toBe(0.2);
    expect(card!.worstPillar).toBe('a');
    expect(0.6 * card!.wmean! + 0.4 * card!.worst!).toBeCloseTo(card!.overall!, 3);
    expect(card!.leaves).toMatchObject({
      bidsReceived: 1,
      singleOffer: true,
      isEauction: false,
      procedureType: 'Открита процедура',
      annexCount: 2,
      costOverrunRatio: 1.4,
      authorityHhi: 0.74,
      repeatWinIntensity: 0.71,
      edgeAgeYears: 9.0,
    });
    expect(card!.coverageFlags).toEqual({ bids: true, sme: false, estimate: true, overrun: true });
    expect(card!.cpvDivision).toBe('45');
    expect(card!.authoritySlug).toBe('100000001');
    expect(card!.slug).toBe('1'); // /contracts/1
  });

  it('returns the unknown card for a value_suspect contract — unscored, not zero', async () => {
    const card = await getQualityScorecard(d1, 'c:3');
    expect(card!.known).toBe(false);
    expect(card!.overall).toBeNull();
    expect(card!.wmean).toBeNull();
    expect(card!.worstPillar).toBeNull();
    expect(card!.valueFlag).toBe('value_suspect');
  });

  it('returns null for an unknown contract id', async () => {
    expect(await getQualityScorecard(d1, 'c:missing')).toBeNull();
  });
});

describe('getQualitySummary', () => {
  it('rolls up the hub-card numbers', async () => {
    const s = await getQualitySummary(d1);
    expect(s.totalContracts).toBe(4);
    expect(s.scoredContracts).toBe(3);
    expect(s.avgOverall).toBeCloseTo(0.556, 3);
  });
});
