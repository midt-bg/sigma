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
  CompetitionPair,
  CompetitionTotals,
  SectorRef,
} from '@sigma/api-contract';
import { CPV_SECTORS } from '@sigma/config';
import { cleanName, entityName } from '@sigma/shared';
import { authoritySlug, companySlug } from './identity';
import { typeLabel } from './rows';

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
const SECTOR_OPTION_LIMIT = 12;

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
// single offer, by contract count and by value (amount_eur IS NOT NULL, the same basis the homepage
// and the rollups use, so the totals match across the site).
async function competitionTotals(db: D1Database, p: CompetitionParams): Promise<CompetitionTotals> {
  const s = scope(p);
  const where = ['c.bids_received IS NOT NULL', 'c.bids_received >= 1', ...s.where];
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS contracts,
         SUM(CASE WHEN c.bids_received = 1 THEN 1 ELSE 0 END) AS single_offer,
         COALESCE(SUM(c.amount_eur), 0) AS value_eur,
         COALESCE(SUM(CASE WHEN c.bids_received = 1 THEN c.amount_eur ELSE 0 END), 0) AS single_value_eur
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
  // Site-wide value basis (amount_eur IS NOT NULL), matching the rollups and the other panels.
  const where = ['c.amount_eur IS NOT NULL', ...s.where];
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
    // Same value basis as the totals and concentration queries and the site-wide rollups.
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

// Sector select options: the present sectors by value (curated label), capped. Same source as getFlows.
async function sectorOptions(db: D1Database): Promise<SectorRef[]> {
  const { results } = await db
    .prepare(`SELECT division FROM sector_totals ORDER BY value_eur DESC LIMIT ?`)
    .bind(SECTOR_OPTION_LIMIT)
    .all<{ division: string }>();
  const byCode = new Map(CPV_SECTORS.map((s) => [s.code, s]));
  return results
    .map((r) => byCode.get(r.division))
    .filter((s): s is (typeof CPV_SECTORS)[number] => Boolean(s))
    .map((s) => ({ code: s.code, label: s.short ?? s.label, short: s.short ?? s.label }));
}

export async function getCompetition(
  db: D1Database,
  p: CompetitionParams,
): Promise<CompetitionData> {
  const top = p.top === MAX_TOP ? MAX_TOP : DEFAULT_TOP;
  const minContracts = p.minContracts ?? DEFAULT_MIN_CONTRACTS;
  const scoped = { ...p, minContracts };
  const [totals, bySingleOffer, byConcentration, topPairs, sectors] = await Promise.all([
    competitionTotals(db, p),
    authoritiesBySingleOffer(db, scoped, top),
    authoritiesByConcentration(db, scoped, top),
    topRecurringPairs(db, p, top),
    sectorOptions(db),
  ]);
  return {
    totals,
    bySingleOffer,
    byConcentration,
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
