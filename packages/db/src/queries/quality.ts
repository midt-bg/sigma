// Quality index: read-only queries over the Contract Quality / Health Index tables the ETL builds
// (scripts/derive-contract-features.sql — contract_features + the six *_quality_totals rollups).
// Scores are [0,1] REALs (spec §12.0); NULL means "insufficient data" and is NEVER coerced to 0 —
// unscored (value_suspect / coverage < 0.40) contracts are excluded from every average upstream, and
// this layer only reads what the ETL wrote. In the site's neutrality stance (§1.3, mirrors
// competition.ts): a low score is a weak-quality SIGNAL, not proof of wrongdoing.

import type {
  QualityContractRow,
  QualityContractSort,
  QualityCoverageTier,
  QualityData,
  QualityGrain,
  QualityLeaves,
  QualityOverview,
  QualityPillars,
  QualityRankDir,
  QualityRankRow,
  QualityRankSort,
  QualityScorecard,
  QualitySummary,
} from '@sigma/api-contract';
import { CPV_SECTORS } from '@sigma/config';
import { cleanName, entityName } from '@sigma/shared';
import { authoritySlug, companySlug, contractSlug } from './identity';
import { typeLabel } from './rows';

export interface QualityParams {
  grain?: QualityGrain;
  sort?: QualityRankSort;
  dir?: QualityRankDir | null; // ranking direction; defaulted per sort key (see qualityRankDefaultDir)
  contractSort?: QualityContractSort;
  sel?: string | null; // selected ranking key → scopes the contracts list
  contractId?: string | null; // scorecard subject; defaults to the weakest listed contract
  band?: string | null; // histogram score-band filter over the contracts list (validated here)
  top?: number;
  rankFrom?: number | null; // „Разбивка" avg-index range, display-scale ints 0–100 (validated here)
  rankTo?: number | null;
}

const DEFAULT_TOP = 20;
const MAX_TOP = 50;
const CONTRACT_LIMIT = 12;
// Authority/supplier rows need a minimal scored sample before an average is meaningful (same
// small-sample guard as competition's minContracts). Sector/region/year/funding are corpus-wide cuts.
const MIN_SCORED = 20;

/**
 * Default ranking direction per sort key — the page's historical reading order: score lists the
 * weakest rows first (asc), contracts lists the biggest samples first (desc). ?rdir flips it.
 */
export function qualityRankDefaultDir(sort: QualityRankSort): QualityRankDir {
  return sort === 'contracts' ? 'desc' : 'asc';
}

/** Pillar weights (spec §3.2); the ETL renormalizes over non-NULL pillars, we mirror that here. */
export const QUALITY_WEIGHTS: Record<keyof QualityPillars, number> = {
  a: 0.3,
  b: 0.15,
  c: 0.25,
  d: 0.2,
  e: 0.1,
};

/** §6.2 confidence label over score_coverage. 'none' = withheld („недостатъчно данни"). */
export function coverageTier(coverage: number | null | undefined): QualityCoverageTier {
  if (coverage == null || coverage < 0.4) return 'none';
  if (coverage >= 0.8) return 'high';
  if (coverage >= 0.6) return 'medium';
  return 'low';
}

interface OverviewRow {
  total: number;
  scored: number;
  suspect: number;
  avg_overall: number | null;
  mean_coverage: number | null;
  avg_a: number | null;
  avg_b: number | null;
  avg_c: number | null;
  avg_d: number | null;
  avg_e: number | null;
  conf_high: number;
  conf_medium: number;
  conf_low: number;
  conf_none: number;
}

async function qualityOverview(db: D1Database): Promise<QualityOverview> {
  const [row, bins] = await Promise.all([
    db
      .prepare(
        // AVG ignores NULLs, so every mean is over the rows that actually carry that score — an
        // unscored contract never drags an average toward zero (§1.3).
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN score_overall IS NOT NULL THEN 1 ELSE 0 END) AS scored,
                SUM(CASE WHEN value_flag = 'value_suspect' THEN 1 ELSE 0 END) AS suspect,
                AVG(score_overall) AS avg_overall,
                AVG(score_coverage) AS mean_coverage,
                AVG(score_a) AS avg_a, AVG(score_b) AS avg_b, AVG(score_c) AS avg_c,
                AVG(score_d) AS avg_d, AVG(score_e) AS avg_e,
                SUM(CASE WHEN score_overall IS NOT NULL AND score_coverage >= 0.8 THEN 1 ELSE 0 END) AS conf_high,
                SUM(CASE WHEN score_overall IS NOT NULL AND score_coverage >= 0.6 AND score_coverage < 0.8 THEN 1 ELSE 0 END) AS conf_medium,
                SUM(CASE WHEN score_overall IS NOT NULL AND score_coverage < 0.6 THEN 1 ELSE 0 END) AS conf_low,
                SUM(CASE WHEN score_overall IS NULL THEN 1 ELSE 0 END) AS conf_none
         FROM contract_features`,
      )
      .first<OverviewRow>(),
    db
      .prepare(
        // 20 equal bins over [0,1]; a perfect 1.0 lands in the top bin instead of a phantom 21st.
        `SELECT CASE WHEN score_overall >= 1.0 THEN 19 ELSE CAST(score_overall * 20 AS INTEGER) END AS bin,
                COUNT(*) AS count
         FROM contract_features WHERE score_overall IS NOT NULL
         GROUP BY bin ORDER BY bin`,
      )
      .all<{ bin: number; count: number }>(),
  ]);
  return {
    totalContracts: row?.total ?? 0,
    scoredContracts: row?.scored ?? 0,
    suspectContracts: row?.suspect ?? 0,
    avgOverall: row?.avg_overall ?? null,
    meanCoverage: row?.mean_coverage ?? null,
    pillars: {
      a: row?.avg_a ?? null,
      b: row?.avg_b ?? null,
      c: row?.avg_c ?? null,
      d: row?.avg_d ?? null,
      e: row?.avg_e ?? null,
    },
    histogram: bins.results,
    confidence: {
      high: row?.conf_high ?? 0,
      medium: row?.conf_medium ?? 0,
      low: row?.conf_low ?? 0,
      none: row?.conf_none ?? 0,
    },
  };
}

interface RankRow {
  key: string;
  name: string | null;
  sub: string | null;
  avg_overall: number;
  avg_a: number | null;
  avg_b: number | null;
  avg_c: number | null;
  avg_d: number | null;
  avg_e: number | null;
  total_contracts: number;
  scored_contracts: number;
  mean_coverage: number | null;
}

const FUNDING_LABELS: Record<string, string> = {
  eu: 'Европейско финансиране',
  national: 'Национално финансиране',
};

// One SELECT per grain over its *_quality_totals rollup. Each SELECT projects the same column list
// (missing pillar averages as NULL — e.g. the sector rollup only stores avg_a/avg_c), so the mapper
// below is grain-agnostic. Weakest-first is the page's default reading order.
function rankSql(grain: QualityGrain): string {
  const cols = (a: string, b: string, c: string, d: string, e: string) =>
    `${a} AS avg_a, ${b} AS avg_b, ${c} AS avg_c, ${d} AS avg_d, ${e} AS avg_e`;
  switch (grain) {
    case 'authority':
      return `SELECT authority_id AS key, name, type_group AS sub, avg_overall,
                     ${cols('avg_a', 'avg_b', 'avg_c', 'avg_d', 'avg_e')},
                     total_contracts, scored_contracts, mean_coverage
              FROM authority_quality_totals
              WHERE avg_overall IS NOT NULL AND scored_contracts >= ?`;
    case 'supplier':
      return `SELECT bidder_id AS key, name, NULL AS sub, avg_overall,
                     ${cols('NULL', 'NULL', 'avg_c', 'avg_d', 'NULL')},
                     total_contracts, scored_contracts, mean_coverage
              FROM bidder_quality_totals
              WHERE avg_overall IS NOT NULL AND scored_contracts >= ?`;
    case 'sector':
      return `SELECT division AS key, NULL AS name, NULL AS sub, avg_overall,
                     ${cols('avg_a', 'NULL', 'avg_c', 'NULL', 'NULL')},
                     total_contracts, scored_contracts, mean_coverage
              FROM sector_quality_totals
              WHERE avg_overall IS NOT NULL AND division <> 'NA' AND scored_contracts >= ?`;
    case 'region':
      return `SELECT nuts AS key, nuts_label AS name, nuts AS sub, avg_overall,
                     ${cols('NULL', 'NULL', 'NULL', 'NULL', 'NULL')},
                     total_contracts, scored_contracts, mean_coverage
              FROM region_quality_totals
              WHERE avg_overall IS NOT NULL AND nuts <> 'NA' AND scored_contracts >= ?`;
    case 'year':
      return `SELECT year AS key, year AS name, NULL AS sub, avg_overall,
                     ${cols('avg_a', 'avg_b', 'avg_c', 'avg_d', 'avg_e')},
                     total_contracts, scored_contracts, mean_coverage
              FROM year_quality_totals
              WHERE avg_overall IS NOT NULL AND year <> 'NA' AND scored_contracts >= ?`;
    case 'funding':
      return `SELECT funding_key AS key, NULL AS name, NULL AS sub, avg_overall,
                     ${cols('NULL', 'NULL', 'NULL', 'NULL', 'NULL')},
                     total_contracts, scored_contracts, mean_coverage
              FROM funding_quality_totals
              WHERE avg_overall IS NOT NULL AND scored_contracts >= ?`;
  }
}

async function qualityRanking(
  db: D1Database,
  grain: QualityGrain,
  sort: QualityRankSort,
  dir: QualityRankDir,
  top: number,
  minScored: number,
  range: { from: number | null; to: number | null }, // avg_overall bounds in [0,1], both inclusive
): Promise<QualityRankRow[]> {
  // Direction is an allow-listed literal ('asc'|'desc' validated in getQuality) — never raw input.
  const d = dir === 'desc' ? 'DESC' : 'ASC';
  const order =
    sort === 'contracts'
      ? `ORDER BY total_contracts ${d}, avg_overall ASC, key`
      : // ties break toward the larger sample (the more telling case)
        `ORDER BY avg_overall ${d}, total_contracts DESC, key`;
  // Avg-index range filter (?rfrom/?rto, already divided from the 0–100 display scale): bound
  // params appended after the grain SQL's minScored placeholder. Both bounds are inclusive, so a
  // from=to pin keeps rows sitting exactly on the boundary.
  const rangeWhere =
    (range.from != null ? ' AND avg_overall >= ?' : '') +
    (range.to != null ? ' AND avg_overall <= ?' : '');
  const rangeParams = [range.from, range.to].filter((v): v is number => v != null);
  const { results } = await db
    .prepare(`${rankSql(grain)}${rangeWhere} ${order} LIMIT ?`)
    .bind(minScored, ...rangeParams, top)
    .all<RankRow>();
  const sectorByCode = new Map(CPV_SECTORS.map((s) => [s.code, s.short ?? s.label]));
  return results.map((r) => {
    let href: string | null = null;
    let name = r.name ?? r.key;
    let sub = r.sub;
    if (grain === 'authority') {
      href = `/authorities/${authoritySlug(r.key)}`;
      name = cleanName(name);
      sub = typeLabel(sub);
    } else if (grain === 'supplier') {
      href = `/companies/${companySlug(r.key)}`;
      name = cleanName(name);
      sub = 'доставчик';
    } else if (grain === 'sector') {
      name = `${r.key} · ${sectorByCode.get(r.key) ?? 'CPV дивизия'}`;
      sub = 'CPV дивизия';
    } else if (grain === 'region') {
      name = r.name ?? r.key;
    } else if (grain === 'year') {
      sub = 'период';
    } else if (grain === 'funding') {
      name = FUNDING_LABELS[r.key] ?? r.key;
    }
    return {
      key: r.key,
      href,
      name,
      sub,
      avgOverall: r.avg_overall,
      pillars: { a: r.avg_a, b: r.avg_b, c: r.avg_c, d: r.avg_d, e: r.avg_e },
      totalContracts: r.total_contracts,
      scoredContracts: r.scored_contracts,
      meanCoverage: r.mean_coverage,
      coverageTier: coverageTier(r.mean_coverage),
    };
  });
}

// Contracts-list / scorecard scope: a selected ranking row narrows the list to its contracts. The
// key shapes match what the ETL grouped by in the corresponding *_quality_totals build.
function contractScope(
  grain: QualityGrain,
  sel: string | null,
): { where: string; params: unknown[] } {
  if (!sel) return { where: '', params: [] };
  switch (grain) {
    case 'authority':
      return { where: 'AND t.authority_id = ?', params: [sel] };
    case 'supplier':
      return { where: 'AND c.bidder_id = ?', params: [sel] };
    case 'sector':
      return { where: 'AND substr(t.cpv_code, 1, 2) = ?', params: [sel] };
    case 'region':
      return { where: 'AND t.place_of_performance = ?', params: [sel] };
    case 'year':
      return { where: 'AND substr(c.signed_at, 1, 4) = ?', params: [sel] };
    case 'funding':
      return sel === 'eu'
        ? { where: 'AND c.eu_funded = 1', params: [] }
        : { where: 'AND (c.eu_funded IS NULL OR c.eu_funded = 0)', params: [] };
  }
}

interface ContractRowRaw {
  id: string;
  signed_at: string | null;
  cpv_code: string | null;
  authority_id: string;
  authority_name: string;
  bidder_id: string;
  bidder_name: string;
  bidder_kind: 'company' | 'consortium';
  amount_eur: number | null;
  score_overall: number | null;
  score_a: number | null;
  score_b: number | null;
  score_c: number | null;
  score_d: number | null;
  score_e: number | null;
  score_coverage: number | null;
  value_flag: string | null;
}

function mapContractRow(r: ContractRowRaw): QualityContractRow {
  const bidderName = cleanName(r.bidder_name);
  return {
    id: r.id,
    slug: contractSlug(r.id),
    signedAt: r.signed_at,
    cpvDivision: r.cpv_code && r.cpv_code.trim().length >= 2 ? r.cpv_code.trim().slice(0, 2) : null,
    authorityName: cleanName(r.authority_name),
    authoritySlug: authoritySlug(r.authority_id),
    bidderDisplayName: entityName(bidderName, r.bidder_kind),
    bidderSlug: companySlug(r.bidder_id),
    amountEur: r.amount_eur,
    overall: r.score_overall,
    pillars: { a: r.score_a, b: r.score_b, c: r.score_c, d: r.score_d, e: r.score_e },
    coverage: r.score_coverage,
    coverageTier: coverageTier(r.score_coverage),
    valueFlag: r.value_flag,
  };
}

const CONTRACT_SELECT = `
  SELECT c.id, c.signed_at, t.cpv_code, t.authority_id, a.name AS authority_name,
         c.bidder_id, b.name AS bidder_name, b.kind AS bidder_kind, c.amount_eur,
         f.score_overall, f.score_a, f.score_b, f.score_c, f.score_d, f.score_e,
         f.score_coverage, f.value_flag
  FROM contract_features f
  JOIN contracts c ON c.id = f.contract_id
  JOIN tenders t ON t.id = c.tender_id
  JOIN authorities a ON a.id = t.authority_id
  JOIN bidders b ON b.id = c.bidder_id`;

/**
 * Histogram score-band filter → [lo, hi) over score_overall. Bin index '0'–'19' maps to the exact
 * 5-point bins the overview histogram is built from (bin 19 closes at 1.0 inclusive, mirroring the
 * `score >= 1.0 → 19` clause in qualityOverview); 'weak'|'mid'|'good' map to the page's zone bands.
 * Returns null for anything else — an unknown value must never reach SQL.
 */
export function qualityBandRange(band: string): { lo: number; hi: number | null } | null {
  if (/^(?:[0-9]|1[0-9])$/.test(band)) {
    const bin = Number(band);
    return { lo: bin / 20, hi: bin === 19 ? null : (bin + 1) / 20 };
  }
  if (band === 'weak') return { lo: 0, hi: 0.5 };
  if (band === 'mid') return { lo: 0.5, hi: 0.7 };
  if (band === 'good') return { lo: 0.7, hi: null };
  return null;
}

async function qualityContracts(
  db: D1Database,
  grain: QualityGrain,
  sel: string | null,
  sort: QualityContractSort,
  band: string | null,
): Promise<QualityContractRow[]> {
  const scope = contractScope(grain, sel);
  // NULL score_overall never satisfies >= — unscored contracts stay outside every band, not at 0.
  const range = band ? qualityBandRange(band) : null;
  const bandWhere = range
    ? `AND f.score_overall >= ?${range.hi != null ? ' AND f.score_overall < ?' : ''}`
    : '';
  const bandParams = range ? (range.hi != null ? [range.lo, range.hi] : [range.lo]) : [];
  // Scored contracts lead (weakest first); unscored value_suspect rows are still listed — after the
  // scored ones — so exclusion is visible, not silent. Coverage-withheld rows stay off this list.
  const order =
    sort === 'value'
      ? 'ORDER BY c.amount_eur DESC, c.id'
      : 'ORDER BY (f.score_overall IS NULL), f.score_overall ASC, c.amount_eur DESC, c.id';
  const { results } = await db
    .prepare(
      `${CONTRACT_SELECT}
       WHERE (f.score_overall IS NOT NULL OR f.value_flag = 'value_suspect') ${scope.where} ${bandWhere}
       ${order} LIMIT ?`,
    )
    .bind(...scope.params, ...bandParams, CONTRACT_LIMIT)
    .all<ContractRowRaw>();
  return results.map(mapContractRow);
}

interface ScorecardRowRaw extends ContractRowRaw {
  procedure_type: string | null;
  bids_received: number | null;
  single_offer: number | null;
  sme_rate: number | null;
  is_eauction: number | null;
  is_accelerated: number | null;
  bid_window_days: number | null;
  annex_count: number | null;
  cost_overrun_ratio: number | null;
  estimate_dev_ratio: number | null;
  first_amend_shock: number | null;
  authority_hhi: number | null;
  repeat_win_intensity: number | null;
  edge_age_years: number | null;
  sector_win_share: number | null;
  date_flag: string | null;
  subcontract_passthrough: number | null;
  duration_days: number | null;
  corrections_count: number | null;
  coverage_bids: number | null;
  coverage_sme: number | null;
  coverage_estimate: number | null;
  coverage_overrun: number | null;
}

const bool = (v: number | null): boolean | null => (v == null ? null : v === 1);

/** Mirror of the ETL blend (§3.3/§12.0): weights renormalized over non-NULL pillars. */
export function qualityBlend(pillars: QualityPillars): {
  wmean: number | null;
  worst: number | null;
  worstPillar: keyof QualityPillars | null;
  effectiveWeights: QualityPillars;
} {
  const keys = Object.keys(QUALITY_WEIGHTS) as (keyof QualityPillars)[];
  const present = keys.filter((k) => pillars[k] != null);
  const effectiveWeights: QualityPillars = { a: null, b: null, c: null, d: null, e: null };
  if (present.length === 0)
    return { wmean: null, worst: null, worstPillar: null, effectiveWeights };
  const wsum = present.reduce((t, k) => t + QUALITY_WEIGHTS[k], 0);
  let wmean = 0;
  let worst: number | null = null;
  let worstPillar: keyof QualityPillars | null = null;
  for (const k of present) {
    const w = QUALITY_WEIGHTS[k] / wsum;
    effectiveWeights[k] = w;
    const s = pillars[k] as number;
    wmean += w * s;
    if (worst == null || s < worst) {
      worst = s;
      worstPillar = k;
    }
  }
  return { wmean, worst, worstPillar, effectiveWeights };
}

export async function getQualityScorecard(
  db: D1Database,
  contractId: string,
): Promise<QualityScorecard | null> {
  const row = await db
    .prepare(
      `SELECT c.id, c.signed_at, t.cpv_code, t.authority_id, a.name AS authority_name,
              c.bidder_id, b.name AS bidder_name, b.kind AS bidder_kind, c.amount_eur,
              f.score_overall, f.score_a, f.score_b, f.score_c, f.score_d, f.score_e,
              f.score_coverage, f.value_flag,
              t.procedure_type, f.bids_received, f.single_offer, f.sme_rate, f.is_eauction,
              f.is_accelerated, f.bid_window_days, f.annex_count, f.cost_overrun_ratio,
              f.estimate_dev_ratio, f.first_amend_shock, f.authority_hhi, f.repeat_win_intensity,
              f.edge_age_years, f.sector_win_share, f.date_flag, f.subcontract_passthrough,
              f.duration_days, f.corrections_count,
              f.coverage_bids, f.coverage_sme, f.coverage_estimate, f.coverage_overrun
       FROM contract_features f
       JOIN contracts c ON c.id = f.contract_id
       JOIN tenders t ON t.id = c.tender_id
       JOIN authorities a ON a.id = t.authority_id
       JOIN bidders b ON b.id = c.bidder_id
       WHERE f.contract_id = ?`,
    )
    .bind(contractId)
    .first<ScorecardRowRaw>();
  if (!row) return null;
  const base = mapContractRow(row);
  const blend = qualityBlend(base.pillars);
  const leaves: QualityLeaves = {
    bidsReceived: row.bids_received,
    singleOffer: bool(row.single_offer),
    smeRate: row.sme_rate,
    isEauction: bool(row.is_eauction),
    procedureType: row.procedure_type === 'неизвестна' ? null : row.procedure_type,
    isAccelerated: bool(row.is_accelerated),
    bidWindowDays: row.bid_window_days,
    annexCount: row.annex_count,
    costOverrunRatio: row.cost_overrun_ratio,
    estimateDevRatio: row.estimate_dev_ratio,
    firstAmendShock: bool(row.first_amend_shock),
    authorityHhi: row.authority_hhi,
    repeatWinIntensity: row.repeat_win_intensity,
    edgeAgeYears: row.edge_age_years,
    sectorWinShare: row.sector_win_share,
    dateFlag: row.date_flag,
    subcontractPassthrough: row.subcontract_passthrough,
    durationDays: row.duration_days,
    correctionsCount: row.corrections_count,
  };
  return {
    ...base,
    known: base.overall != null,
    ...blend,
    leaves,
    coverageFlags: {
      bids: row.coverage_bids === 1,
      sme: row.coverage_sme === 1,
      estimate: row.coverage_estimate === 1,
      overrun: row.coverage_overrun === 1,
    },
  };
}

const GRAINS: QualityGrain[] = ['authority', 'supplier', 'sector', 'region', 'year', 'funding'];

export async function getQuality(db: D1Database, p: QualityParams = {}): Promise<QualityData> {
  const grain: QualityGrain = p.grain && GRAINS.includes(p.grain) ? p.grain : 'authority';
  const sort: QualityRankSort = p.sort === 'contracts' ? 'contracts' : 'score';
  // Direction: strict allow-list, anything else falls back to the sort key's default order.
  const sortDir: QualityRankDir =
    p.dir === 'asc' || p.dir === 'desc' ? p.dir : qualityRankDefaultDir(sort);
  // Avg-index range: display-scale ints 0–100 only (divided to [0,1] at the SQL boundary below);
  // a malformed bound is dropped, an inverted pair is swapped — never passed into SQL as-is.
  const rankBound = (v: number | null | undefined): number | null =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100 ? v : null;
  let rankFrom = rankBound(p.rankFrom);
  let rankTo = rankBound(p.rankTo);
  if (rankFrom != null && rankTo != null && rankFrom > rankTo)
    [rankFrom, rankTo] = [rankTo, rankFrom];
  const contractSort: QualityContractSort = p.contractSort === 'value' ? 'value' : 'score';
  const sel = p.sel ?? null;
  // Validate at the query boundary (the route validates too, but this module must not trust its
  // callers): a bogus band is dropped, never passed into SQL.
  const band = p.band && qualityBandRange(p.band) ? p.band : null;
  const top = p.top && p.top > 0 ? Math.min(Math.floor(p.top), MAX_TOP) : DEFAULT_TOP;
  const minScored = grain === 'authority' || grain === 'supplier' ? MIN_SCORED : 1;
  const [overview, ranking, contracts] = await Promise.all([
    qualityOverview(db),
    qualityRanking(db, grain, sort, sortDir, top, minScored, {
      from: rankFrom != null ? rankFrom / 100 : null,
      to: rankTo != null ? rankTo / 100 : null,
    }),
    qualityContracts(db, grain, sel, contractSort, band),
  ]);
  // p.contractId is the explicit ?contract request; scorecardId also falls back to the weakest
  // listed contract so a card always renders. Those must stay distinct in `scope`: only the explicit
  // request is echoed back for links to preserve (scope.contractId), or the auto-picked default
  // would get "baked into" the URL on the very first navigation and pin every later view to it.
  const explicitContractId = p.contractId ?? null;
  const scorecardId = explicitContractId ?? contracts[0]?.id ?? null;
  const scorecard = scorecardId ? await getQualityScorecard(db, scorecardId) : null;
  return {
    overview,
    ranking,
    contracts,
    scorecard,
    scope: {
      grain,
      sort,
      sortDir,
      contractSort,
      sel,
      band,
      contractId: explicitContractId,
      rankFrom,
      rankTo,
      top,
      minScored,
    },
  };
}

/** Lightweight rollup for the /analytics hub card. */
export async function getQualitySummary(db: D1Database): Promise<QualitySummary> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN score_overall IS NOT NULL THEN 1 ELSE 0 END) AS scored,
              AVG(score_overall) AS avg_overall,
              AVG(score_coverage) AS mean_coverage
       FROM contract_features`,
    )
    .first<{
      total: number;
      scored: number;
      avg_overall: number | null;
      mean_coverage: number | null;
    }>();
  return {
    totalContracts: row?.total ?? 0,
    scoredContracts: row?.scored ?? 0,
    avgOverall: row?.avg_overall ?? null,
    meanCoverage: row?.mean_coverage ?? null,
  };
}
