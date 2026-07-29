import type {
  ConflictLink,
  ConflictContract,
  ConflictRelation,
  CompanyConflicts,
  OfficialConflicts,
} from '@sigma/api-contract';
import { contractSlug, personSlug } from './identity';

// True for D1's „no such table: …" — the свързани-лица migration (0003) not yet applied to this D1 (a fresh
// or half-provisioned env). Lets every conflict read degrade to an empty/absent state (→ empty page or 404)
// instead of a 500, so the feature's routes are safe to deploy ahead of the data-ship (ADR-0031 robustness).
export function isMissingTableError(e: unknown): boolean {
  return e instanceof Error && /no such table/i.test(e.message);
}

// Read-only query layer for свързани лица. The PUBLIC surface shows the official's OWN declared material
// ownership only: private_ownership — the official declared their OWN stake (relation owns/owns+manages).
// A CLOSE RELATIVE's declared stake (family_ownership, relation 'related') is collected and audited but
// NEVER surfaced by name in v1: the card's official + company + ЕИК + ТР link re-identifies a sole-owner
// relative in one click, which GDPR (C-37/20) treats as personal data we cannot publish without legal
// sign-off (ADR-0030, superseding ADR-0023). Family is instead reported as a NAMELESS aggregate — counts
// only, no rows — via getWithheldFamilyAggregate. Management/board roles without a declared stake, and
// listed securities, are never surfaced (noise at best, defamatory at worst). Only status='published' rows
// leave the pipeline; held, suppressed, withdrawn (divested) and internal (family) links never surface.
// Ranking is NEXUS-first (own-institution, then contemporaneous) so the strongest signals lead — never
// company revenue, which surfaced blue-chip noise first.

interface LinkRow {
  link_key: string;
  person_id: string;
  official: string;
  company: string;
  eik: string;
  relation: string;
  contemporaneous: number;
  own_institution: string;
  first_declared_year: string | null;
  last_declared_year: string | null;
  match_method: string;
  contract_count: number;
  contract_value_eur: number | null;
  contemporaneous_contract_count: number;
  contemporaneous_value_eur: number | null;
  first_contract_year: string | null;
  last_contract_year: string | null;
  source_url: string | null;
}

// The winner's contracts, joined exactly as the ETL aggregate does (contracts→tenders→authorities→bidders,
// matched by eik_normalized) so any read-time subset is a true subset of the stored contract_count/value.
// Alias-distinct (cc/tt/aa/bb) so it composes as a correlated subquery under the LINK_SELECT `il`/`b` scope.
const CONTRACT_JOIN = `FROM contracts cc
    JOIN tenders tt ON tt.id = cc.tender_id
    JOIN authorities aa ON aa.id = tt.authority_id
    JOIN bidders bb ON bb.id = cc.bidder_id`;
// Contemporaneous = signing year within [first_declared_year, last_declared_year] — the same min/max span
// classify.temporalStatus uses for the stored `contemporaneous` flag, so count>0 ⇔ contemporaneous. NULL
// bounds (no declared year) ⇒ never in-window, matching the flag. `il` is the outer LINK_SELECT row.
const IN_WINDOW = `il.first_declared_year IS NOT NULL AND il.last_declared_year IS NOT NULL
      AND cc.signed_at IS NOT NULL
      AND CAST(strftime('%Y', cc.signed_at) AS INTEGER)
          BETWEEN CAST(il.first_declared_year AS INTEGER) AND CAST(il.last_declared_year AS INTEGER)`;

// Shared projection: published material-ownership links (self + family) + names + a representative
// declaration URL (provenance, never fabricated). Callers append a scope predicate + ORDER BY.
// NEXUS_ORDER ranks the strongest conflict signal first: a contract from the official's OWN institution,
// then a stake held during a contract award, then value as a tiebreak — link_key last for stability. The
// value tiebreak is the CONTEMPORANEOUS (in-window) sum, not the lifetime contract_value_eur, so the rank
// order matches the headline € the card shows (LINK_SELECT.contemporaneous_value_eur, an output alias
// ORDER BY resolves); ranking by lifetime would float an official above one with a larger actual conflict.
export const NEXUS_ORDER = `(il.own_institution = 'exact') DESC, il.contemporaneous DESC,
    contemporaneous_value_eur DESC, il.link_key`;

// The surface shows private_ownership only (ADR-0030): family_ownership is withheld upstream (never
// status='published'), so the old redundant-family collapse — dropping a family link when a self stake in
// the same winner exists — is moot and has been removed with the family surface itself. The nameless family
// aggregate (getWithheldFamilyAggregate) applies the same anti-double-count exclusion at the count level.
export const LINK_SELECT = `SELECT il.link_key, il.person_id, p.name AS official, b.name AS company, il.eik,
    il.relation, il.contemporaneous, il.own_institution,
    il.first_declared_year, il.last_declared_year, il.match_method,
    il.contract_count, il.contract_value_eur, il.first_contract_year, il.last_contract_year,
    -- The conflict-window subset of contract_count / contract_value_eur, derived at read time (no stored
    -- column, so a correction ships without an ETL re-run). NB: several correlated subqueries per row
    -- (the two contemporaneous splits, the source_url, and the redundant-family EXISTS); the leaderboard is
    -- ≤1000 rows and hourly-cached, so the extra scans are immaterial — revisit only if the eligible set
    -- grows or the cache TTL shrinks.
    (SELECT COUNT(*) ${CONTRACT_JOIN} WHERE bb.eik_normalized = il.eik AND ${IN_WINDOW})
      AS contemporaneous_contract_count,
    (SELECT SUM(cc.amount_eur) ${CONTRACT_JOIN} WHERE bb.eik_normalized = il.eik AND ${IN_WINDOW})
      AS contemporaneous_value_eur,
    -- source_url is the office-holder's OWN public declaration. Only self (private_ownership) links surface
    -- now, so it always names the office-holder themselves — correct provenance, never a relative's document
    -- (ConflictCards renders it as „декларация"). ADR-0030 retired family from the surface, so the former
    -- family-NULL CASE guard is moot and removed.
    (SELECT d.source_url FROM declared_interests di JOIN declarations d ON d.id = di.declaration_id
     WHERE d.person_id = il.person_id AND di.entity_key = il.entity_key
     ORDER BY d.declared_year DESC LIMIT 1) AS source_url
  FROM interest_links il
  JOIN persons p ON p.id = il.person_id
  JOIN bidders b ON b.id = il.bidder_id
  WHERE il.status = 'published' AND il.interest_class = 'private_ownership'`;

// own_institution is a 4-value verdict; only the deterministic 'exact' surfaces as true (the
// name_contains/locality heuristics are disclosed elsewhere, never asserted as fact).
function toLink(r: LinkRow): ConflictLink {
  return {
    linkKey: r.link_key,
    officialSlug: personSlug(r.person_id),
    official: r.official,
    company: r.company,
    eik: r.eik,
    relation: r.relation as ConflictRelation,
    contemporaneous: r.contemporaneous === 1,
    ownInstitution: r.own_institution === 'exact',
    firstDeclaredYear: r.first_declared_year,
    lastDeclaredYear: r.last_declared_year,
    matchMethod: r.match_method,
    contractCount: r.contract_count,
    contractValueEur: r.contract_value_eur,
    contemporaneousContractCount: r.contemporaneous_contract_count,
    contemporaneousValueEur: r.contemporaneous_value_eur,
    firstContractYear: r.first_contract_year,
    lastContractYear: r.last_contract_year,
    sourceUrl: r.source_url,
  };
}

export const LEADERBOARD_SQL = `${LINK_SELECT}
  ORDER BY ${NEXUS_ORDER} LIMIT ?`;

/** The leaderboard: office-holders who declared a material ownership stake (their own or a close
 *  relative's) in a procurement winner, ranked NEXUS-first (own-institution → contemporaneous → value). */
export async function getConflictLeaderboard(db: D1Database, limit = 100): Promise<ConflictLink[]> {
  try {
    const rows = (await db.prepare(LEADERBOARD_SQL).bind(limit).all<LinkRow>()).results;
    return rows.map(toLink);
  } catch (e) {
    if (isMissingTableError(e)) return []; // un-migrated env → empty surface, not a 500
    throw e;
  }
}

// The nameless close-relative aggregate (ADR-0030). Officials who declared a CLOSE RELATIVE's material stake
// in a procurement winner are collected + audited but NEVER named on the surface; instead we report the
// count. This SQL returns SCALARS ONLY — never a person/company row — so nothing re-identifiable ships to the
// client (the loader payload is the public `.data` twin). It counts family_ownership links withheld ONLY by
// the family policy (status='internal' — passed every gate, not held/withdrawn/suppressed), and EXCLUDES any
// family link redundant with the official's OWN published stake in the same winner: that € is already in the
// named headline and that official is already on the board, so counting them again would inflate the figure.
export const WITHHELD_FAMILY_AGGREGATE_SQL = `SELECT
    COUNT(*) AS link_count,
    COUNT(DISTINCT il.person_id) AS official_count,
    COALESCE(SUM(il.contract_value_eur), 0) AS total_eur
  FROM interest_links il
  WHERE il.interest_class = 'family_ownership' AND il.status = 'internal'
    AND NOT EXISTS (SELECT 1 FROM interest_links s
      WHERE s.person_id = il.person_id AND s.eik = il.eik
        AND s.status = 'published' AND s.interest_class = 'private_ownership')`;

export interface WithheldFamilyAggregate {
  linkCount: number;
  officialCount: number;
  totalEur: number;
}

/** The nameless close-relative aggregate for the leaderboard headline (ADR-0030) — counts only, no names,
 *  no rows. Reported as „N длъжностни лица … в дружества, спечелили €X" so the public signal survives while
 *  no private individual is identified. */
export async function getWithheldFamilyAggregate(db: D1Database): Promise<WithheldFamilyAggregate> {
  const empty = { linkCount: 0, officialCount: 0, totalEur: 0 };
  try {
    const r = await db
      .prepare(WITHHELD_FAMILY_AGGREGATE_SQL)
      .first<{ link_count: number; official_count: number; total_eur: number }>();
    return {
      linkCount: r?.link_count ?? 0,
      officialCount: r?.official_count ?? 0,
      totalEur: r?.total_eur ?? 0,
    };
  } catch (e) {
    if (isMissingTableError(e)) return empty; // un-migrated env → no aggregate, not a 500
    throw e;
  }
}

export const OFFICIAL_SQL = `${LINK_SELECT} AND il.person_id = ?
  ORDER BY ${NEXUS_ORDER}`;

/** One office-holder's declared ownership links. Null when there are none (the page 404s rather than
 *  render an empty page under someone's name). */
export async function getOfficialConflicts(
  db: D1Database,
  personId: string,
): Promise<OfficialConflicts | null> {
  try {
    const rows = (await db.prepare(OFFICIAL_SQL).bind(personId).all<LinkRow>()).results;
    if (rows.length === 0) return null;
    const links = rows.map(toLink);
    return { official: links[0]!.official, links };
  } catch (e) {
    if (isMissingTableError(e)) return null; // un-migrated env → 404, not a 500
    throw e;
  }
}

export const COMPANY_SQL = `${LINK_SELECT} AND il.eik = ?
  ORDER BY ${NEXUS_ORDER}`;

/** Office-holders with a declared ownership stake in one winner (by ЕИК). Null when there are none. */
export async function getCompanyConflicts(
  db: D1Database,
  eik: string,
): Promise<CompanyConflicts | null> {
  try {
    const rows = (await db.prepare(COMPANY_SQL).bind(eik).all<LinkRow>()).results;
    if (rows.length === 0) return null;
    return { company: rows[0]!.company, eik, links: rows.map(toLink) };
  } catch (e) {
    if (isMissingTableError(e)) return null; // un-migrated env → 404, not a 500
    throw e;
  }
}

interface ContractRow {
  id: string;
  signed_at: string | null;
  authority: string | null;
  authority_id: string;
  authority_total_eur: number | null; // authority_totals.spent_eur; null when the body has no rollup row
  contract_kind: string | null;
  contract_number: string | null;
  amount_eur: number | null;
  procedure_type: string | null; // award procedure (tenders.procedure_type); 'неизвестна' for synthetic tenders
  subject: string | null; // tender subject (tenders.title AS subject)
  temporal: ConflictContract['temporal'];
}

// One published link's contracts, each marked against the declared-stake window. The WHERE gate on
// status/interest_class + the redundant-family collapse means a non-surfaced link_key returns [] — never a
// way to enumerate held/internal links OR to confirm a family link the leaderboard collapsed away.
// Marking mirrors classify.temporalStatus (min/max declared-year span) so the 'contemporaneous'
// rows here are exactly the subset counted by contemporaneous_contract_count in LINK_SELECT.
export const LINK_CONTRACTS_SQL = `SELECT cc.id, cc.signed_at, aa.name AS authority, aa.id AS authority_id,
    ath.spent_eur AS authority_total_eur, cc.contract_kind,
    cc.contract_number, cc.amount_eur,
    COALESCE(NULLIF(cc.contract_subject, ''), tt.title) AS subject,
    NULLIF(tt.procedure_type, 'неизвестна') AS procedure_type,
    CASE
      WHEN cc.signed_at IS NULL OR il.first_declared_year IS NULL OR il.last_declared_year IS NULL THEN 'unknown'
      WHEN CAST(strftime('%Y', cc.signed_at) AS INTEGER) < CAST(il.first_declared_year AS INTEGER) THEN 'before'
      WHEN CAST(strftime('%Y', cc.signed_at) AS INTEGER) > CAST(il.last_declared_year AS INTEGER) THEN 'after'
      ELSE 'contemporaneous'
    END AS temporal
  FROM interest_links il
    JOIN bidders bb ON bb.eik_normalized = il.eik
    JOIN contracts cc ON cc.bidder_id = bb.id
    JOIN tenders tt ON tt.id = cc.tender_id
    JOIN authorities aa ON aa.id = tt.authority_id
    LEFT JOIN authority_totals ath ON ath.authority_id = aa.id
  WHERE il.link_key = ?
    AND il.status = 'published' AND il.interest_class = 'private_ownership'
  ORDER BY (temporal = 'contemporaneous') DESC, cc.signed_at DESC, cc.amount_eur DESC`;

/** The contracts of one published link, contemporaneous-first, each flagged in/out the declared window.
 *  Empty for an unknown or non-surfaced link_key (never leaks internal/held/withdrawn links). */
export async function getLinkContracts(
  db: D1Database,
  linkKey: string,
): Promise<ConflictContract[]> {
  let rows: ContractRow[];
  try {
    rows = (await db.prepare(LINK_CONTRACTS_SQL).bind(linkKey).all<ContractRow>()).results;
  } catch (e) {
    if (isMissingTableError(e)) return []; // un-migrated env → empty contracts, not a 500
    throw e;
  }
  return rows.map((r) => ({
    contractSlug: contractSlug(r.id),
    signedAt: r.signed_at,
    authority: r.authority ?? '',
    authorityId: r.authority_id,
    authorityTotalEur: r.authority_total_eur,
    contractKind: r.contract_kind,
    contractNumber: r.contract_number,
    amountEur: r.amount_eur,
    // procedure_type is NULLIF'd against 'неизвестна' (the migration's synthetic-tender sentinel) in the
    // query, so null here means "procedure unknown" → the UI omits it rather than showing a placeholder.
    procedureType: r.procedure_type,
    subject: r.subject,
    temporal: r.temporal,
  }));
}
