import type {
  ConflictLink,
  ConflictContract,
  ConflictRelation,
  CompanyConflicts,
  OfficialConflicts,
} from '@sigma/api-contract';
import { contractSlug, personSlug } from './identity';

// Read-only query layer for свързани лица. The PUBLIC surface shows declared material OWNERSHIP only:
//   • private_ownership — the official declared their OWN stake (relation owns/owns+manages).
//   • family_ownership  — the official declared a CLOSE RELATIVE's stake (relation 'related'); the
//     relative is anonymized downstream as „свързано лице" (name never stored). Both rest on the
//     official's own public declaration + public procurement records.
// Management/board roles without a declared stake, and listed securities, are never surfaced (noise at
// best, defamatory at worst). Only status='published' rows leave the pipeline; held, suppressed and
// withdrawn (divested) links never surface. Ranking is NEXUS-first (own-institution, then contemporaneous)
// so the strongest signals lead — never company revenue, which surfaced blue-chip noise first.

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

// The redundant-family collapse predicate (full rationale in the LINK_SELECT comment below): drop a family
// link when the same official also holds a PUBLISHED self stake in the same winner. Shared so every surface —
// the leaderboard/official/company projection AND the per-link contracts route — hides the EXACT same links;
// a consumer that omitted it (LINK_CONTRACTS_SQL did) became an existence-oracle for the suppressed relative.
export const NOT_REDUNDANT_FAMILY = `NOT (il.interest_class = 'family_ownership' AND EXISTS (
    SELECT 1 FROM interest_links s WHERE s.person_id = il.person_id AND s.bidder_id = il.bidder_id
      AND s.status = 'published' AND s.interest_class = 'private_ownership'))`;
export const LINK_SELECT = `SELECT il.link_key, il.person_id, p.name AS official, b.name AS company, il.eik,
    il.relation, il.contemporaneous, il.own_institution,
    il.first_declared_year, il.last_declared_year, il.match_method,
    il.contract_count, il.contract_value_eur, il.first_contract_year, il.last_contract_year,
    -- The conflict-window subset of contract_count / contract_value_eur, derived at read time (no stored
    -- column, so a correction ships without an ETL re-run). ponytail: several correlated subqueries per row
    -- (the two contemporaneous splits, the source_url, and the redundant-family EXISTS); the leaderboard is
    -- ≤1000 rows and hourly-cached, so the extra scans are immaterial — revisit only if the eligible set
    -- grows or the cache TTL shrinks.
    (SELECT COUNT(*) ${CONTRACT_JOIN} WHERE bb.eik_normalized = il.eik AND ${IN_WINDOW})
      AS contemporaneous_contract_count,
    (SELECT SUM(cc.amount_eur) ${CONTRACT_JOIN} WHERE bb.eik_normalized = il.eik AND ${IN_WINDOW})
      AS contemporaneous_value_eur,
    (SELECT d.source_url FROM declared_interests di JOIN declarations d ON d.id = di.declaration_id
     WHERE d.person_id = il.person_id AND di.entity_key = il.entity_key
     ORDER BY d.declared_year DESC LIMIT 1) AS source_url
  FROM interest_links il
  JOIN persons p ON p.id = il.person_id
  JOIN bidders b ON b.id = il.bidder_id
  WHERE il.status = 'published' AND il.interest_class IN ('private_ownership', 'family_ownership')
    -- Collapse each (official, company) to ONE nexus. An official can hold BOTH their own stake and a
    -- relative's stake in the same winner — two published links (own→private_ownership, relative→
    -- family_ownership), identical contract value, since load.mjs keys aggregation on (person|eik|scope).
    -- Surfacing both would (a) double-count that winner's € in the headline and (b) show the same person
    -- twice for one company: a de-anonymisation vector (own stake + a same-surname co-owner ⇒ ТР
    -- cross-reference names the "anonymous" relative). When an own-stake link exists, drop the redundant
    -- family link to the same winner. Standalone family links (a relative owns a firm the official does
    -- not) are untouched. (per (person,eik) there is at most one link per scope, so this is the only dup.)
    AND ${NOT_REDUNDANT_FAMILY}`;

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
  const rows = (await db.prepare(LEADERBOARD_SQL).bind(limit).all<LinkRow>()).results;
  return rows.map(toLink);
}

export const OFFICIAL_SQL = `${LINK_SELECT} AND il.person_id = ?
  ORDER BY ${NEXUS_ORDER}`;

/** One office-holder's declared ownership links. Null when there are none (the page 404s rather than
 *  render an empty page under someone's name). */
export async function getOfficialConflicts(
  db: D1Database,
  personId: string,
): Promise<OfficialConflicts | null> {
  const rows = (await db.prepare(OFFICIAL_SQL).bind(personId).all<LinkRow>()).results;
  if (rows.length === 0) return null;
  const links = rows.map(toLink);
  return { official: links[0]!.official, links };
}

export const COMPANY_SQL = `${LINK_SELECT} AND il.eik = ?
  ORDER BY ${NEXUS_ORDER}`;

/** Office-holders with a declared ownership stake in one winner (by ЕИК). Null when there are none. */
export async function getCompanyConflicts(
  db: D1Database,
  eik: string,
): Promise<CompanyConflicts | null> {
  const rows = (await db.prepare(COMPANY_SQL).bind(eik).all<LinkRow>()).results;
  if (rows.length === 0) return null;
  return { company: rows[0]!.company, eik, links: rows.map(toLink) };
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
    AND il.status = 'published' AND il.interest_class IN ('private_ownership', 'family_ownership')
    -- Same collapse as LINK_SELECT: a family link the surface hides (because a published self stake exists
    -- for the same person+winner) must return [] here too, or this route is an existence-oracle that
    -- confirms the suppressed relative's stake — the de-anonymisation vector ADR-0023 forbids.
    AND ${NOT_REDUNDANT_FAMILY}
  ORDER BY (temporal = 'contemporaneous') DESC, cc.signed_at DESC, cc.amount_eur DESC`;

/** The contracts of one published link, contemporaneous-first, each flagged in/out the declared window.
 *  Empty for an unknown or non-surfaced link_key (never leaks internal/held/withdrawn links). */
export async function getLinkContracts(
  db: D1Database,
  linkKey: string,
): Promise<ConflictContract[]> {
  const rows = (await db.prepare(LINK_CONTRACTS_SQL).bind(linkKey).all<ContractRow>()).results;
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
