import type {
  ConflictLink,
  ConflictContract,
  ConflictRelation,
  CompanyConflicts,
  OfficialConflicts,
} from '@sigma/api-contract';
import { contractSlug, personSlug } from './identity';

// The tables migration 0003 (свързани-лица) creates. A „no such table" for one of THESE means 0003 is not
// applied on this D1 yet (a fresh or half-provisioned env) — the safe, expected gap we degrade for. A
// „no such table" for a CORE table (bidders, contracts, …) is real schema loss and must NOT be masked as
// „0003 not applied yet": it has to propagate so the operator sees a 500, not a silently empty surface
// (ydimitrof/todorkolev #226 — B5). Keep in sync with 0003_related_persons_foundation.sql's CREATE TABLEs.
const CONFLICT_TABLES = [
  'interest_links',
  'persons',
  'declarations',
  'declared_interests',
  'interest_link_authorities',
  'related_persons_internal',
];
// „D1_ERROR: no such table: interest_links: SQLITE_ERROR" → capture the table name and test membership.
const MISSING_TABLE = /no such table:\s*(?:main\.)?"?([a-z_]+)"?/i;

// True only when the missing table is one 0003 owns — never a core table. Exported for the read helpers and
// their tests. A non-table error (syntax, constraint) is never matched and always propagates.
export function isMissingConflictTableError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const m = MISSING_TABLE.exec(e.message);
  return m != null && CONFLICT_TABLES.includes(m[1]!.toLowerCase());
}

// Soft-fail decision + telemetry: true (and logs ONE warning) when a conflict read hit a missing 0003 table,
// so the caller returns the empty/absent fallback; false for every other error, which the caller rethrows.
// The warning is the signal Todor asked for — an operator must learn the env is serving without conflict
// data, not discover it from a silently empty leaderboard.
function conflictSchemaAbsent(e: unknown, op: string): boolean {
  if (!isMissingConflictTableError(e)) return false;
  console.warn(
    `related-persons: "${op}" degraded to an empty surface — свързани-лица schema (migration 0003) is not present on this D1: ${(e as Error).message}`,
  );
  return true;
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
  institution: string | null;
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
// SCOPE, stated honestly (todorkolev #226 — N7): this is the SPAN from first to last filing, so a gap year
// inside it (the official skipped a filing) still counts as in-window. The card + methodology call this „в
// декларирания период" — the declared PERIOD, first→last — not a per-year claim, so the span is not silently
// presented as continuous coverage. Narrowing it to the exact set of filed years needs the per-year filing
// set (a data-model change) and is tracked separately; today the honest framing is the span.
const IN_WINDOW = `il.first_declared_year IS NOT NULL AND il.last_declared_year IS NOT NULL
      AND cc.signed_at IS NOT NULL
      AND CAST(strftime('%Y', cc.signed_at) AS INTEGER)
          BETWEEN CAST(il.first_declared_year AS INTEGER) AND CAST(il.last_declared_year AS INTEGER)`;

// Shared projection: published material-ownership links (self + family) + names + a representative
// declaration URL (provenance, never fabricated). Callers append a scope predicate + ORDER BY.
// NEXUS_ORDER ranks the strongest conflict signal first: a contract from the official's OWN institution,
// then a stake held during a contract award, then value as a tiebreak — link_key last for stability. Both
// the „held during an award" flag and the value tiebreak read from the LIVE, read-time contemporaneous
// subset (contemporaneous_contract_count / _value_eur, output aliases ORDER BY resolves) — NOT the frozen
// ETL flag il.contemporaneous (todorkolev #226 — N8): the card's chip is the live count, so ranking by the
// frozen flag could float a chip-less row above a row that shows the chip. Value tiebreak is the in-window
// sum (matching the € the card shows), never the lifetime total.
export const NEXUS_ORDER = `(il.own_institution = 'exact') DESC, (contemporaneous_contract_count > 0) DESC,
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
     ORDER BY d.declared_year DESC LIMIT 1) AS source_url,
    -- The official's LATEST declared institution — disambiguates namesakes on the surface (person grain is
    -- (name, institution), ADR-0026; same subquery the search projection uses). Correlated per row, but the
    -- leaderboard is ≤1000 rows and hourly-cached, so the extra scan is immaterial.
    (SELECT d.institution FROM declarations d WHERE d.person_id = il.person_id
     ORDER BY d.declared_year DESC LIMIT 1) AS institution
  FROM interest_links il
  JOIN persons p ON p.id = il.person_id
  JOIN bidders b ON b.id = il.bidder_id
  WHERE il.status = 'published' AND il.interest_class = 'private_ownership'
    -- Read-time zero-contract gate (todorkolev #226 — N9). The ETL sets contract_count at build time; if the
    -- EOP corpus is later refreshed and this winner's contracts drop to zero, the frozen count is stale and
    -- the link would linger on the leaderboard only to expand to „no contracts found". Gate on LIVE contract
    -- existence so a winner with no current contracts drops off the surface entirely — „if we can't show the
    -- contracts, we don't show the link" (methodology promise). ≤1000 rows, hourly-cached → the scan is cheap.
    AND EXISTS (SELECT 1 ${CONTRACT_JOIN} WHERE bb.eik_normalized = il.eik)`;

// own_institution is a 4-value verdict; only the deterministic 'exact' surfaces as true (the
// name_contains/locality heuristics are disclosed elsewhere, never asserted as fact).
function toLink(r: LinkRow): ConflictLink {
  return {
    linkKey: r.link_key,
    officialSlug: personSlug(r.person_id),
    official: r.official,
    institution: r.institution,
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
    if (conflictSchemaAbsent(e, 'leaderboard')) return []; // un-migrated env → empty surface, not a 500
    throw e;
  }
}

// Minimum cell size for the nameless family aggregate (todorkolev #226 — B2). Below this many DISTINCT
// officials, the aggregate is a re-identification hazard: „1 лице" is close to naming, and any small exact
// count can be cross-referenced. Under the threshold we publish NOTHING (the surface says nothing rather
// than a small cell), enforced server-side so no sub-threshold count reaches the public `.data` twin.
export const MIN_FAMILY_CELL = 5;

// The nameless close-relative aggregate (ADR-0030). Officials who declared a CLOSE RELATIVE's material stake
// in a procurement WINNER are collected + audited but NEVER named on the surface; instead we report a COUNT
// ONLY — no € (todorkolev #226 — B2). An exact euro sum is a money fingerprint: cross-referenced with a
// company's public contract total it re-identifies the (single-owner) relative, exactly the disclosure the
// nameless aggregate exists to avoid. So this SQL returns two COUNTS and no monetary value.
// It counts family_ownership links withheld ONLY by the family policy (status='internal' — passed every
// gate, not held/withdrawn/suppressed), whose company actually WON at least one contract (contract_count>0 —
// an official whose relative's company won nothing is not a procurement conflict), and EXCLUDES any family
// link redundant with the official's OWN published stake in the same winner (already named on the board).
export const WITHHELD_FAMILY_AGGREGATE_SQL = `SELECT
    COUNT(*) AS link_count,
    COUNT(DISTINCT il.person_id) AS official_count
  FROM interest_links il
  WHERE il.interest_class = 'family_ownership' AND il.status = 'internal'
    AND il.contract_count > 0
    AND NOT EXISTS (SELECT 1 FROM interest_links s
      WHERE s.person_id = il.person_id AND s.eik = il.eik
        AND s.status = 'published' AND s.interest_class = 'private_ownership')`;

export interface WithheldFamilyAggregate {
  linkCount: number;
  officialCount: number;
}

/** The nameless close-relative aggregate for the leaderboard (ADR-0030) — COUNTS ONLY, no names, no rows,
 *  no €. Reported as „N длъжностни лица, декларирали дял на близък в дружества изпълнители" so the public
 *  signal survives while no private individual is identified. Below MIN_FAMILY_CELL distinct officials the
 *  aggregate is suppressed entirely (returns zeros) — a small cell is a re-identification hazard, so nothing
 *  sub-threshold ever reaches the public payload. */
export async function getWithheldFamilyAggregate(db: D1Database): Promise<WithheldFamilyAggregate> {
  const empty = { linkCount: 0, officialCount: 0 };
  try {
    const r = await db
      .prepare(WITHHELD_FAMILY_AGGREGATE_SQL)
      .first<{ link_count: number; official_count: number }>();
    const officialCount = r?.official_count ?? 0;
    if (officialCount < MIN_FAMILY_CELL) return empty; // min-cell: suppress a small, re-identifiable cell
    return { linkCount: r?.link_count ?? 0, officialCount };
  } catch (e) {
    if (conflictSchemaAbsent(e, 'family-aggregate')) return empty; // un-migrated env → no aggregate, not a 500
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
    if (conflictSchemaAbsent(e, 'official')) return null; // un-migrated env → 404, not a 500
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
    if (conflictSchemaAbsent(e, 'company')) return null; // un-migrated env → 404, not a 500
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

// Hard ceiling on one link's expanded contract list. A winner with thousands of contracts would otherwise
// return the whole set on every row expansion, growing the payload and D1 scan unbounded as the corpus
// grows (ydimitrof #226: perf/DoS surface). The card summary already shows the authoritative total
// (contractCount) and the in-window count (contemporaneousContractCount), so a capped list against a larger
// count reads as an honest "showing the top N" signal, never silent truncation. ORDER BY puts the
// contemporaneous, most-recent, highest-value contracts first, so the cap keeps the most relevant rows.
// ponytail: fixed cap, not pagination — add keyset paging only if a real winner exceeds this in practice.
export const LINK_CONTRACTS_LIMIT = 500;

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
  ORDER BY (temporal = 'contemporaneous') DESC, cc.signed_at DESC, cc.amount_eur DESC
  LIMIT ${LINK_CONTRACTS_LIMIT}`;

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
    if (conflictSchemaAbsent(e, 'link-contracts')) return []; // un-migrated env → empty contracts, not a 500
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
