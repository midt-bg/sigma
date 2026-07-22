// Competition: neutral, factual competition indicators over the contracts corpus. It surfaces the
// single-offer share per authority, supplier concentration (HHI), and the most-recurring
// authority/company pairs. Read-only and edge-cached at the route; mirrors home.ts / getFlows (live
// aggregation, no new rollup table in v1). In the spirit of the methodology (СИГМА „не тълкува, а
// показва"): these are neutral ratios. A high single-offer share is a weak-competition SIGNAL, not a
// verdict on the authority or the company.

import type {
  CompetitionAuthority,
  CompetitionConcentration,
  CompetitionData,
  CompetitionDirectAward,
  CompetitionPair,
  CompetitionTotals,
  ProcedureCompetition,
} from '@sigma/api-contract';
import {
  CLASSIFIED_PROCEDURE_TYPES,
  NON_COMPETITIVE_PROCEDURE_TYPES,
  PROCEDURE_UNKNOWN_KEY,
  procedureGroup,
} from '@sigma/config';
import { cleanName, entityName } from '@sigma/shared';
import { authoritySlug, companySlug } from './identity';
import { typeLabel } from './rows';
import { sectorOptions } from './sectors';

export interface CompetitionParams {
  sector?: string | null;
  year?: string | null;
  funding?: 'all' | 'eu' | 'national';
  top?: number;
  minContracts?: number;
  authorityId?: string | null;
}

const DEFAULT_TOP = 20;
const MAX_TOP = 50;
const DEFAULT_MIN_CONTRACTS = 20;

// Shared contract-scope filter, identical across panels: sector via the parent tender's CPV division,
// year via signed_at, EU funding via eu_funded. Every contract has a parent tender (synthetic when the
// source has none, see normalize-raw.sql), so the INNER JOIN never drops a row.
function scope(p: CompetitionParams): { join: string; where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (p.sector) {
    where.push('substr(t.cpv_code, 1, 2) = ?');
    params.push(p.sector);
  }
  if (p.year) {
    where.push('substr(c.signed_at, 1, 4) = ?');
    params.push(p.year);
  }
  if (p.authorityId) {
    where.push('t.authority_id = ?');
    params.push(p.authorityId);
  }
  if (p.funding === 'eu') where.push('c.eu_funded = 1');
  else if (p.funding === 'national') where.push('(c.eu_funded IS NULL OR c.eu_funded = 0)');
  return { join: 'JOIN tenders t ON t.id = c.tender_id', where, params };
}

interface TotalsRow {
  contracts: number;
  single_offer: number;
  value_eur: number;
  single_value_eur: number;
}

// Headline: of contracts with a KNOWN offer count (bids_received >= 1), what share were awarded on a
// single offer — by contract count, and by VALUE. The value share sums POSITIVE amount_eur only
// (CASE … > 0); a negative upstream value_low value would otherwise push the share outside [0,1]
// (#153 review). The count share is unaffected — it counts rows, not value.
async function competitionTotals(db: D1Database, p: CompetitionParams): Promise<CompetitionTotals> {
  const s = scope(p);
  const where = ['c.bids_received IS NOT NULL', 'c.bids_received >= 1', ...s.where];
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS contracts,
         SUM(CASE WHEN c.bids_received = 1 THEN 1 ELSE 0 END) AS single_offer,
         COALESCE(SUM(CASE WHEN c.amount_eur > 0 THEN c.amount_eur ELSE 0 END), 0) AS value_eur,
         COALESCE(SUM(CASE WHEN c.bids_received = 1 AND c.amount_eur > 0 THEN c.amount_eur ELSE 0 END), 0) AS single_value_eur
       FROM contracts c ${s.join} WHERE ${where.join(' AND ')}`,
    )
    .bind(...s.params)
    .first<TotalsRow>();
  const contracts = row?.contracts ?? 0;
  const singleOffer = row?.single_offer ?? 0;
  const valueEur = row?.value_eur ?? 0;
  const singleValueEur = row?.single_value_eur ?? 0;
  return {
    contracts,
    singleOffer,
    singleOfferShare: contracts > 0 ? singleOffer / contracts : 0,
    valueEur,
    singleOfferValueEur: singleValueEur,
    singleOfferValueShare: valueEur > 0 ? singleValueEur / valueEur : 0,
  };
}

export async function getAuthoritySingleOffer(
  db: D1Database,
  authorityId: string,
): Promise<CompetitionTotals> {
  return competitionTotals(db, { authorityId });
}

export async function getAuthorityProcedureCompetition(
  db: D1Database,
  authorityId: string,
): Promise<ProcedureCompetition> {
  return procedureCompetition(db, { authorityId });
}

interface AuthorityShareRow {
  authority_id: string;
  name: string;
  type_group: string | null;
  contracts: number;
  single_offer: number;
  value_eur: number;
}

async function authoritiesBySingleOffer(
  db: D1Database,
  p: CompetitionParams,
  top: number,
): Promise<CompetitionAuthority[]> {
  const s = scope(p);
  const where = ['c.bids_received IS NOT NULL', 'c.bids_received >= 1', ...s.where];
  const minContracts = p.minContracts ?? DEFAULT_MIN_CONTRACTS;
  const { results } = await db
    .prepare(
      `SELECT t.authority_id AS authority_id, a.name AS name, a.type_group AS type_group,
              COUNT(*) AS contracts,
              SUM(CASE WHEN c.bids_received = 1 THEN 1 ELSE 0 END) AS single_offer,
              -- display total: full clean basis to match the authority rollups (not a share denominator)
              COALESCE(SUM(c.amount_eur), 0) AS value_eur
       FROM contracts c ${s.join} JOIN authorities a ON a.id = t.authority_id
       WHERE ${where.join(' AND ')}
       GROUP BY t.authority_id
       HAVING COUNT(*) >= ?
       -- ties on single-offer share break toward more contracts: a larger sample is the more telling case
       ORDER BY (SUM(CASE WHEN c.bids_received = 1 THEN 1 ELSE 0 END) * 1.0 / COUNT(*)) DESC, COUNT(*) DESC, t.authority_id
       LIMIT ?`,
    )
    .bind(...s.params, minContracts, top)
    .all<AuthorityShareRow>();
  return results.map((r) => ({
    slug: authoritySlug(r.authority_id),
    name: cleanName(r.name),
    typeLabel: typeLabel(r.type_group),
    contracts: r.contracts,
    singleOffer: r.single_offer,
    singleOfferShare: r.contracts > 0 ? r.single_offer / r.contracts : 0,
    valueEur: r.value_eur,
  }));
}

interface ConcentrationRow {
  authority_id: string;
  name: string;
  type_group: string | null;
  suppliers: number;
  contracts: number;
  value_eur: number;
  hhi: number;
}

// Herfindahl-Hirschman Index over an authority's spend per supplier (the sum of each supplier's
// squared share). A value of 1 means a single supplier takes everything. Restricted to authorities
// with at least 2 suppliers (concentration is only meaningful when there was a choice) and at least
// `minContracts` contracts (drops small-sample noise).
async function authoritiesByConcentration(
  db: D1Database,
  p: CompetitionParams,
  top: number,
): Promise<CompetitionConcentration[]> {
  const s = scope(p);
  // HHI is a share-of-spend metric, so it must sum POSITIVE value only. A negative amount_eur (an
  // upstream value_low row — summed but flagged, see checkNoNegativeValues) breaks the share
  // normalisation: shares stop summing to 1 → hhi > 1, and `ORDER BY hhi DESC` then ranks that
  // authority #1; an authority whose spend nets to 0 divides by zero → hhi NULL (where the type says
  // number). `> 0` closes both, and is the documented accuracy-correct value basis. (#153 review)
  const where = ['c.amount_eur > 0', ...s.where];
  const minContracts = p.minContracts ?? DEFAULT_MIN_CONTRACTS;
  const { results } = await db
    .prepare(
      `WITH pair AS (
         SELECT t.authority_id AS authority_id, c.bidder_id AS bidder_id,
                SUM(c.amount_eur) AS spent, COUNT(*) AS n
         FROM contracts c ${s.join}
         WHERE ${where.join(' AND ')}
         GROUP BY t.authority_id, c.bidder_id
       ),
       tot AS (
         SELECT authority_id, SUM(spent) AS total, SUM(n) AS contracts, COUNT(*) AS suppliers
         FROM pair GROUP BY authority_id
       )
       SELECT p.authority_id AS authority_id, a.name AS name, a.type_group AS type_group,
              tot.suppliers AS suppliers, tot.contracts AS contracts, tot.total AS value_eur,
              SUM((p.spent / tot.total) * (p.spent / tot.total)) AS hhi
       FROM pair p JOIN tot ON tot.authority_id = p.authority_id
       JOIN authorities a ON a.id = p.authority_id
       WHERE tot.contracts >= ? AND tot.suppliers >= 2
       GROUP BY p.authority_id
       -- ties on HHI break toward higher spend: the same concentration over more money matters more
       ORDER BY hhi DESC, value_eur DESC, p.authority_id
       LIMIT ?`,
    )
    .bind(...s.params, minContracts, top)
    .all<ConcentrationRow>();
  return results.map((r) => ({
    slug: authoritySlug(r.authority_id),
    name: cleanName(r.name),
    typeLabel: typeLabel(r.type_group),
    suppliers: r.suppliers,
    contracts: r.contracts,
    valueEur: r.value_eur,
    hhi: r.hhi,
  }));
}

interface ProcedureRow {
  procedure_type: string | null;
  contracts: number;
  value_eur: number;
}

// Direct-award headline: split the corpus by the procedure's competitiveness (the taxonomy lives in
// @sigma/config, so this groups by the raw procedure_type and folds in JS, exactly like the loader
// folds facet_counts). „Direct award" = a non-competitive procedure (awarded without a call for bids).
// The share denominator is the classified set (competitive + non-competitive); neutral and synthetic
// („Неизвестна") procedures are reported on the side, never folded into the share.
async function procedureCompetition(
  db: D1Database,
  p: CompetitionParams,
): Promise<ProcedureCompetition> {
  const s = scope(p);
  const where = s.where.length ? `WHERE ${s.where.join(' AND ')}` : '';
  const { results } = await db
    .prepare(
      // value sums positive amount_eur only, so nonCompetitiveValueShare stays in [0,1] (#153 review);
      // contracts (the count) is unaffected.
      `SELECT t.procedure_type AS procedure_type,
              COUNT(*) AS contracts,
              COALESCE(SUM(CASE WHEN c.amount_eur > 0 THEN c.amount_eur ELSE 0 END), 0) AS value_eur
       FROM contracts c ${s.join}
       ${where}
       GROUP BY t.procedure_type`,
    )
    .bind(...s.params)
    .all<ProcedureRow>();

  let competitiveContracts = 0;
  let nonCompetitiveContracts = 0;
  let neutralContracts = 0;
  let unknownContracts = 0;
  let classifiedValueEur = 0;
  let nonCompetitiveValueEur = 0;
  let totalContracts = 0;
  for (const r of results) {
    const g = procedureGroup(r.procedure_type);
    totalContracts += r.contracts;
    if (g.competitive === true) {
      competitiveContracts += r.contracts;
      classifiedValueEur += r.value_eur;
    } else if (g.competitive === false) {
      nonCompetitiveContracts += r.contracts;
      nonCompetitiveValueEur += r.value_eur;
      classifiedValueEur += r.value_eur;
    } else if (g.key === PROCEDURE_UNKNOWN_KEY) {
      unknownContracts += r.contracts;
    } else {
      neutralContracts += r.contracts;
    }
  }
  const classifiedContracts = competitiveContracts + nonCompetitiveContracts;
  return {
    classifiedContracts,
    nonCompetitiveContracts,
    nonCompetitiveShare:
      classifiedContracts > 0 ? nonCompetitiveContracts / classifiedContracts : 0,
    classifiedValueEur,
    nonCompetitiveValueEur,
    nonCompetitiveValueShare:
      classifiedValueEur > 0 ? nonCompetitiveValueEur / classifiedValueEur : 0,
    competitiveContracts,
    neutralContracts,
    unknownContracts,
    totalContracts,
  };
}

interface DirectAwardRow {
  authority_id: string;
  name: string;
  type_group: string | null;
  classified: number;
  non_competitive: number;
  value_eur: number;
}

// Authorities ranked by their direct-award share: of the contracts with a classified procedure, the
// share awarded without a call for bids. The procedure lists are bound parameters from @sigma/config
// (the SQL carries no procedure-type literals); both shares restrict to the classified denominator so
// synthetic „Неизвестна" tenders never inflate or dilute the rate. Min-contracts gate drops noise.
async function authoritiesByDirectAward(
  db: D1Database,
  p: CompetitionParams,
  top: number,
): Promise<CompetitionDirectAward[]> {
  const s = scope(p);
  const minContracts = p.minContracts ?? DEFAULT_MIN_CONTRACTS;
  const directPlaceholders = NON_COMPETITIVE_PROCEDURE_TYPES.map(() => '?').join(', ');
  const classifiedPlaceholders = CLASSIFIED_PROCEDURE_TYPES.map(() => '?').join(', ');
  const where = [`TRIM(t.procedure_type) IN (${classifiedPlaceholders})`, ...s.where];
  const { results } = await db
    .prepare(
      `SELECT t.authority_id AS authority_id, a.name AS name, a.type_group AS type_group,
              COUNT(*) AS classified,
              SUM(CASE WHEN TRIM(t.procedure_type) IN (${directPlaceholders}) THEN 1 ELSE 0 END) AS non_competitive,
              -- display total: full clean basis to match the authority rollups (not a share denominator)
              COALESCE(SUM(c.amount_eur), 0) AS value_eur
       FROM contracts c ${s.join} JOIN authorities a ON a.id = t.authority_id
       WHERE ${where.join(' AND ')}
       GROUP BY t.authority_id
       HAVING COUNT(*) >= ?
       -- ties on direct-award share break toward more contracts (a larger sample is more telling)
       ORDER BY (non_competitive * 1.0 / classified) DESC, classified DESC, t.authority_id
       LIMIT ?`,
    )
    .bind(
      ...NON_COMPETITIVE_PROCEDURE_TYPES,
      ...CLASSIFIED_PROCEDURE_TYPES,
      ...s.params,
      minContracts,
      top,
    )
    .all<DirectAwardRow>();
  return results.map((r) => ({
    slug: authoritySlug(r.authority_id),
    name: cleanName(r.name),
    typeLabel: typeLabel(r.type_group),
    classified: r.classified,
    nonCompetitive: r.non_competitive,
    nonCompetitiveShare: r.classified > 0 ? r.non_competitive / r.classified : 0,
    valueEur: r.value_eur,
  }));
}

interface PairRow {
  authority_id: string;
  bidder_id: string;
  authority_name: string;
  bidder_name: string;
  bidder_kind: 'company' | 'consortium';
  won_eur: number;
  contracts: number;
}

// Recurring pairings: the same authority and company across the most separate contracts. The default
// (no filter) reads the flow_pairs rollup; a sector/year/funding filter falls back to a scoped base
// aggregation. Ordered by contract count (recurrence), tie-broken by value, like getFlows (which
// orders by value).
async function topRecurringPairs(
  db: D1Database,
  p: CompetitionParams,
  top: number,
): Promise<CompetitionPair[]> {
  const filtered = Boolean(
    p.sector || p.year || p.authorityId || (p.funding && p.funding !== 'all'),
  );
  let rows: PairRow[];
  if (!filtered) {
    const { results } = await db
      .prepare(
        `SELECT authority_id, bidder_id, authority_name, bidder_name, bidder_kind, won_eur, contracts
         FROM flow_pairs ORDER BY contracts DESC, won_eur DESC LIMIT ?`,
      )
      .bind(top)
      .all<PairRow>();
    rows = results;
  } else {
    const s = scope(p);
    // won_eur is a DISPLAY total (the pair's awarded spend), so it keeps the full clean basis
    // (amount_eur IS NOT NULL) to reconcile with the flow_pairs rollup the unfiltered branch above
    // reads — a plain sum tolerates a small negative value_low row, unlike the HHI/share bases.
    const where = ['c.amount_eur IS NOT NULL', ...s.where];
    const { results } = await db
      .prepare(
        `SELECT t.authority_id AS authority_id, c.bidder_id AS bidder_id, a.name AS authority_name,
                b.name AS bidder_name, b.kind AS bidder_kind,
                SUM(c.amount_eur) AS won_eur, COUNT(*) AS contracts
         FROM contracts c ${s.join} JOIN authorities a ON a.id = t.authority_id
         JOIN bidders b ON b.id = c.bidder_id
         WHERE ${where.join(' AND ')}
         GROUP BY t.authority_id, c.bidder_id
         ORDER BY contracts DESC, won_eur DESC LIMIT ?`,
      )
      .bind(...s.params, top)
      .all<PairRow>();
    rows = results;
  }
  return rows.map((r, i) => {
    const bidderName = cleanName(r.bidder_name);
    return {
      rank: i + 1,
      authoritySlug: authoritySlug(r.authority_id),
      authorityName: cleanName(r.authority_name),
      bidderSlug: companySlug(r.bidder_id),
      bidderName,
      bidderDisplayName: entityName(bidderName, r.bidder_kind),
      bidderKind: r.bidder_kind,
      contracts: r.contracts,
      wonEur: r.won_eur,
    };
  });
}

export async function getCompetition(
  db: D1Database,
  p: CompetitionParams,
): Promise<CompetitionData> {
  const top = p.top === MAX_TOP ? MAX_TOP : DEFAULT_TOP;
  const minContracts = p.minContracts ?? DEFAULT_MIN_CONTRACTS;
  const scoped = { ...p, minContracts };
  const [totals, procedure, bySingleOffer, byConcentration, byDirectAward, topPairs, sectors] =
    await Promise.all([
      competitionTotals(db, p),
      procedureCompetition(db, p),
      authoritiesBySingleOffer(db, scoped, top),
      authoritiesByConcentration(db, scoped, top),
      authoritiesByDirectAward(db, scoped, top),
      topRecurringPairs(db, p, top),
      sectorOptions(db),
    ]);
  return {
    totals,
    procedure,
    bySingleOffer,
    byConcentration,
    byDirectAward,
    topPairs,
    sectors,
    scope: {
      sector: p.sector ?? null,
      year: p.year ? Number(p.year) : null,
      funding: p.funding ?? 'all',
      top,
      minContracts,
    },
  };
}

export async function getCompetitionSummary(
  db: D1Database,
  p: CompetitionParams = {},
): Promise<{
  totals: CompetitionTotals;
  topConcentration: CompetitionConcentration | null;
}> {
  const top = 1;
  const minContracts = p.minContracts ?? DEFAULT_MIN_CONTRACTS;
  const scoped = { ...p, minContracts };
  const [totals, byConcentration] = await Promise.all([
    competitionTotals(db, p),
    authoritiesByConcentration(db, scoped, top),
  ]);
  return { totals, topConcentration: byConcentration[0] ?? null };
}
