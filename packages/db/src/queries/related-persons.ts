import type {
  ConflictLink,
  ConflictContract,
  ConflictContractFacts,
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
  // 0006 (#279, ADR-0033). Listed here for the same reason as the rest: on an environment where 0006
  // has not been applied yet, the evidence join must degrade to an empty surface rather than a 500.
  'interest_link_evidence',
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

// Read-only query layer for свързани лица. The PUBLIC surface publishes TWO material-ownership classes,
// treated identically (ADR-0032, superseding ADR-0030): the official's OWN declared stake (private_ownership,
// relation owns/owns+manages) AND a CLOSE RELATIVE's declared stake (family_ownership, relation 'related').
// Both are stakes the official disclosed in their own public asset declaration under ЗПКОНПИ; a family stake
// is a conflict signal the law requires them to declare, so withholding it defeats the tool's purpose. The
// three libel rails hold BY CONSTRUCTION and are non-negotiable: the relative is NEVER named (no holder name
// is stored on the conflict path — parse.mjs emits holderRelation, not the holder), the relationship TYPE is
// never asserted (the row says only „дялово участие на свързано лице"), and only officials who file a PUBLIC
// asset declaration reach this path at all. A family link is COLLAPSED when the same official already has an
// own stake in the same winner (NOT_REDUNDANT_FAMILY below) — showing both re-identifies the relative via a ТР
// owner lookup. Management/board roles without a declared stake, and listed securities, are still never
// surfaced (noise at best, defamatory at worst). Only status='published' rows leave the pipeline; held,
// suppressed and withdrawn (divested) links never surface. Ranking is NEXUS-first
// (own-institution, then contemporaneous) so the strongest signals lead — never company revenue, which
// surfaced blue-chip noise first.

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
  evidence_kind: string | null;
  registry_role: string | null;
  entry_number: string | null;
  entry_date: string | null;
  lookup_date: string | null;
}

// The winner's contracts, joined exactly as the ETL aggregate does (contracts→tenders→authorities→bidders,
// matched by eik_normalized) so any read-time subset is a true subset of the stored contract_count/value.
// Alias-distinct (cc/tt/aa/bb) so it composes as a correlated subquery under the LINK_SELECT `il`/`b` scope.
//
// `tt` and `aa` are NOT projected here, which makes both joins look dead and invites deleting them. They
// are not dead — they are the SHAPE, and its counterpart is the WRITER at scripts/cacbg/load.mjs (the
// per-winner contract query that fills contract_count / contract_value_eur). The two must stay identical.
//
// Removing them on the read side ALONE would widen the read to contracts the stored aggregate never
// counted: `contemporaneous_contract_count` could then exceed `contract_count`, and the EXISTS gate below
// (the one that decides whether a link surfaces at all) would publish links the I5 zero-contract gate had
// excluded. Removing them on BOTH sides is defensible — an unresolvable authority currently drops a
// contract from the money everywhere, consistently — but it changes published figures and so must be
// re-baselined against ADR-0033 §10's control totals, not slipped in as a cleanup. Tracked as #226 §1.6.
// `related-persons-sql.test.ts` pins this string to the writer's so neither can be "optimised" alone.
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

// The two surfaced ownership classes (ADR-0032): the official's own stake (private_ownership) and a close
// relative's (family_ownership). Anchored once here + in LINK_CONTRACTS_SQL so the read gate and the
// drill-down never drift.
// …and the identity must rest on a Trade Register fact (#279, ADR-0033). `status='published'` already
// encodes the loader's decision, so this EXISTS is belt-and-braces: it makes the read path refuse a link
// whose seal is missing or whose evidence is a withholding rung, even if a future writer sets status
// wrongly. 'document' and 'confirmed' are the only two rungs that publish; bar_joint_stock, unknown,
// refuted and outside_tr never reach a reader.
export const SURFACED_OWNERSHIP = `il.status = 'published'
    AND il.interest_class IN ('private_ownership', 'family_ownership')
    AND EXISTS (SELECT 1 FROM interest_link_evidence e
                WHERE e.link_key = il.link_key AND e.evidence_kind IN ('document','confirmed'))`;
// Redundant-family collapse (ADR-0032, per todorkolev review). A family link is DROPPED when the SAME official
// already has a published OWN stake in the SAME winner. Rendering both a self row and a family row for one
// (official, ЕИК) is a de-anonymisation vector: the office-holder is himself in that company's Търговски
// регистър owner list, so a reader subtracts him and the „свързано лице" is the remaining (often same-surname)
// co-owner — the relative named by inference. The company is already surfaced by the self row, so the family
// row adds the leak with little marginal signal (the official is not hiding — he declared his own stake too).
// STANDALONE family links (no self stake in that winner) still surface — that is where the „hiding a stake in
// a relative's name" signal is strongest and the relative is not trivially ТР-identifiable. As a side effect,
// at most ONE link per (official, ЕИК) surfaces; a winner shared by TWO DIFFERENT officials still yields two
// links, so per-ЕИК money dedup is the leaderboard's job (conflicts.ts conflictHeadline), not this collapse's.
export const NOT_REDUNDANT_FAMILY = `NOT (il.interest_class = 'family_ownership' AND EXISTS (
      SELECT 1 FROM interest_links s
      WHERE s.person_id = il.person_id AND s.eik = il.eik
        AND s.status = 'published' AND s.interest_class = 'private_ownership'))`;
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
    -- source_url is the office-holder's OWN public declaration. Family links surface too now (ADR-0032), but a
    -- relative's stake is declared IN the official's own asset declaration (parse.mjs reads it from that one
    -- document), so d.person_id = il.person_id resolves to the office-holder either way — the URL always names
    -- the office-holder's document, never a relative's (ConflictDetail renders it as „декларация").
    (SELECT d.source_url FROM declared_interests di JOIN declarations d ON d.id = di.declaration_id
     WHERE d.person_id = il.person_id AND di.entity_key = il.entity_key
     ORDER BY d.declared_year DESC LIMIT 1) AS source_url,
    -- The official's LATEST declared institution — disambiguates namesakes on the surface (person grain is
    -- (name, institution), ADR-0026; same subquery the search projection uses). Correlated per row, but the
    -- leaderboard is ≤1000 rows and hourly-cached, so the extra scan is immaterial.
    (SELECT d.institution FROM declarations d WHERE d.person_id = il.person_id
     ORDER BY d.declared_year DESC LIMIT 1) AS institution,
    -- The evidence the link rests on, so the card can explain itself (ADR-0033 decision 7). LEFT JOIN
    -- rather than an inner one: SURFACED_OWNERSHIP already requires a publishing seal, and an inner join
    -- here would silently re-filter rather than surface a contradiction.
    ev.evidence_kind, ev.registry_role, ev.entry_number, ev.entry_date, ev.lookup_date
  FROM interest_links il
  LEFT JOIN interest_link_evidence ev ON ev.link_key = il.link_key
  JOIN persons p ON p.id = il.person_id
  JOIN bidders b ON b.id = il.bidder_id
  WHERE ${SURFACED_OWNERSHIP}
    -- Read-time zero-contract gate (todorkolev #226 — N9). The ETL sets contract_count at build time; if the
    -- EOP corpus is later refreshed and this winner's contracts drop to zero, the frozen count is stale and
    -- the link would linger on the leaderboard only to expand to „no contracts found". Gate on LIVE contract
    -- existence so a winner with no current contracts drops off the surface entirely — „if we can't show the
    -- contracts, we don't show the link" (methodology promise). ≤1000 rows, hourly-cached → the scan is cheap.
    AND EXISTS (SELECT 1 ${CONTRACT_JOIN} WHERE bb.eik_normalized = il.eik)
    -- …and drop a family link redundant with the official's own stake in the same winner (de-anon guard).
    AND ${NOT_REDUNDANT_FAMILY}`;

// The two rungs that license a public claim (ADR-0033 decision 1), and the ONLY two the card knows how
// to render. Anything else — 'refuted', 'unknown', 'bar_joint_stock', 'outside_tr', a rung added by a
// later rules_version, a typo, or NULL from a row with no seal — is withheld, never mapped.
//
// The mapper used to read `kind === 'confirmed' ? 'confirmed' : 'document'`, which turned every one of
// those into 'document' — the STRONGEST claim on the surface, rendering „лицето е вписано като
// съдружник/собственик": that the register names this specific person in this specific company. The SQL
// gate makes it unreachable today, but the direction was wrong, and this is the one mapping in the
// codebase where a default is a defamatory statement about a named human being rather than a glitch.
// The LEFT JOIN in LINK_SELECT is deliberately not an inner one so a contradiction SURFACES here; the
// old fallback then converted exactly that contradiction into the strongest possible label.
const PUBLISHING_EVIDENCE = new Set(['document', 'confirmed']);

/** Rows whose seal licenses a public claim. Withholding is silent by design — the SQL already filters
 *  these out, so anything reaching here is a contradiction to drop, not a condition to report per row. */
function sealed(rows: LinkRow[]): LinkRow[] {
  return rows.filter((r) => PUBLISHING_EVIDENCE.has(String(r.evidence_kind)));
}

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
    // Narrowed, not defaulted — `sealed()` above has already dropped every other value, so this asserts
    // what the filter guarantees instead of inventing a rung the row never carried.
    evidenceKind: r.evidence_kind as 'document' | 'confirmed',
    registryRole:
      r.registry_role === 'owner' || r.registry_role === 'manager' ? r.registry_role : null,
    registryEntryNumber: r.entry_number,
    registryEntryDate: r.entry_date,
    // Narrowed for the same reason as evidenceKind, not defaulted. `lookup_date` is NOT NULL in
    // migration 0006 and the row only reaches here through the seal filter, so `?? ''` was a branch
    // that could not run — and if the invariant ever broke it would have shipped an empty string as a
    // date, which reads as a valid-but-blank provenance rather than as the contradiction it is.
    registryLookupDate: r.lookup_date as string,
  };
}

export const LEADERBOARD_SQL = `${LINK_SELECT}
  ORDER BY ${NEXUS_ORDER} LIMIT ?`;

/** The leaderboard: office-holders who declared a material ownership stake (their own or a close
 *  relative's) in a procurement winner, ranked NEXUS-first (own-institution → contemporaneous → value). */
export async function getConflictLeaderboard(db: D1Database, limit = 100): Promise<ConflictLink[]> {
  try {
    const rows = sealed((await db.prepare(LEADERBOARD_SQL).bind(limit).all<LinkRow>()).results);
    return rows.map(toLink);
  } catch (e) {
    if (conflictSchemaAbsent(e, 'leaderboard')) return []; // un-migrated env → empty surface, not a 500
    throw e;
  }
}

// Cap the links a single detail page renders — sized to what a page can meaningfully show, not to the corpus
// ceiling (ydimitrof #312 MEDIUM 5). Each link is a rendered case block; past a few dozen the page is unusable
// and the eager contract load (one ЕИК read per distinct winner) fans out too far. NEXUS_ORDER keeps the
// strongest links when it bites. A company with >50 linked officials is far past anything real (the leaderboard
// itself caps at 1000 links total); if one ever appears, the block count is what needs paging, not this number.
export const DETAIL_LINKS_LIMIT = 50;

export const OFFICIAL_SQL = `${LINK_SELECT} AND il.person_id = ?
  ORDER BY ${NEXUS_ORDER} LIMIT ${DETAIL_LINKS_LIMIT}`;

// The union declared window across the links on ONE ЕИК: [min firstDeclaredYear, max lastDeclaredYear]. The
// ЕИК read orders contracts INSIDE this union first, so the LIMIT can never drop a contract that falls in ANY
// of the winner's officials' declared windows — the truth bug ydimitrof #312 HIGH 2 caught (a dropped in-window
// contract makes the detail page read „0 in window" under a headline that says „X от Y"). A null bound means
// that side is absent → the ordering just falls back to signed_at DESC (no window to prioritise).
function unionWindow(links: ConflictLink[]): { lo: number | null; hi: number | null } {
  let lo: number | null = null;
  let hi: number | null = null;
  for (const l of links) {
    const f = l.firstDeclaredYear == null ? null : Number(l.firstDeclaredYear);
    const t = l.lastDeclaredYear == null ? null : Number(l.lastDeclaredYear);
    if (f != null && Number.isFinite(f)) lo = lo == null ? f : Math.min(lo, f);
    if (t != null && Number.isFinite(t)) hi = hi == null ? t : Math.max(hi, t);
  }
  return { lo, hi };
}

// Eagerly load each WINNER's contracts for a detail page (#287), deduped by ЕИК (ydimitrof #312 HIGH 1 + 2). A
// winner's contracts are a function of its ЕИК, NOT the link — the only per-link difference is the `temporal`
// mark (the link's declared window), which the detail component derives. So we fetch each DISTINCT ЕИК ONCE and
// key the result by ЕИК: a COMPANY page (every link on one ЕИК) reads AND serialises the contract set a SINGLE
// time (was N reads + N serialised copies); an OFFICIAL page is one entry per distinct winner. The read is
// ordered union-declared-window-first so the LINK_CONTRACTS_LIMIT cap keeps the in-window contracts. Links here
// are already surfaced (sealed() + the LINK_SELECT gate), so the raw ЕИК read needs no per-link_key gate — the
// gated `getLinkContracts` is kept only for the standalone lazy route.
async function loadLinkContracts(
  db: D1Database,
  links: ConflictLink[],
): Promise<Record<string, ConflictContractFacts[]>> {
  const byEik = new Map<string, ConflictLink[]>();
  for (const l of links) {
    const g = byEik.get(l.eik);
    if (g) g.push(l);
    else byEik.set(l.eik, [l]);
  }
  const entries = await Promise.all(
    [...byEik.entries()].map(async ([eik, eikLinks]) => {
      const { lo, hi } = unionWindow(eikLinks);
      const rows = (await db.prepare(EIK_CONTRACTS_SQL).bind(eik, lo, hi).all<EikContractRow>())
        .results;
      return [eik, rows.map(toFacts)] as const;
    }),
  );
  return Object.fromEntries(entries);
}

/** One office-holder's declared ownership links, with each link's contracts loaded eagerly. Null when there
 *  are none (the page 404s rather than render an empty page under someone's name). */
export async function getOfficialConflicts(
  db: D1Database,
  personId: string,
): Promise<OfficialConflicts | null> {
  try {
    // Filtered BEFORE the emptiness check, so a person whose every link is withheld 404s rather than
    // rendering an empty page under their name.
    const rows = sealed((await db.prepare(OFFICIAL_SQL).bind(personId).all<LinkRow>()).results);
    if (rows.length === 0) return null;
    const links = rows.map(toLink);
    const contracts = await loadLinkContracts(db, links);
    return { official: links[0]!.official, links, contracts };
  } catch (e) {
    if (conflictSchemaAbsent(e, 'official')) return null; // un-migrated env → 404, not a 500
    throw e;
  }
}

export const COMPANY_SQL = `${LINK_SELECT} AND il.eik = ?
  ORDER BY ${NEXUS_ORDER} LIMIT ${DETAIL_LINKS_LIMIT}`;

/** Office-holders with a declared ownership stake in one winner (by ЕИК), with each link's contracts loaded
 *  eagerly. Null when there are none. */
export async function getCompanyConflicts(
  db: D1Database,
  eik: string,
): Promise<CompanyConflicts | null> {
  try {
    const rows = sealed((await db.prepare(COMPANY_SQL).bind(eik).all<LinkRow>()).results);
    if (rows.length === 0) return null;
    const links = rows.map(toLink);
    const contracts = await loadLinkContracts(db, links);
    return { company: rows[0]!.company, eik, links, contracts };
  } catch (e) {
    if (conflictSchemaAbsent(e, 'company')) return null; // un-migrated env → 404, not a 500
    throw e;
  }
}

// A winner's contract row WITHOUT the temporal mark — the columns that depend only on the ЕИК, shared across
// every link on that winner. `getLinkContracts` selects these plus a SQL-computed `temporal` (ContractRow).
interface EikContractRow {
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
}
interface ContractRow extends EikContractRow {
  temporal: ConflictContract['temporal'];
}

// One row → the shared contract FACTS (no temporal). The eager ЕИК read returns these once per winner; the
// detail component derives `temporal` per link (a winner's contracts are the same for every official linked to
// it, only each official's declared window differs — so temporal is a per-link presentation concern, moved
// client-side with `markContracts` in apps/web to keep the DTO one array per ЕИК, not one per link).
function toFacts(r: EikContractRow): ConflictContractFacts {
  return {
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
  };
}

// One row → the full DTO for the gated per-link lazy read, whose SQL computes `temporal` (the ЕИК eager read
// does not — it derives temporal per link client-side). Shares the fact mapping with `toFacts`.
function toContract(r: ContractRow): ConflictContract {
  return { ...toFacts(r), temporal: r.temporal };
}

// Hard ceiling on one link's expanded contract list. A winner with thousands of contracts would otherwise
// return the whole set on every row expansion, growing the payload and D1 scan unbounded as the corpus
// grows (ydimitrof #226: perf/DoS surface). The card summary already shows the authoritative total
// (contractCount) and the in-window count (contemporaneousContractCount), so a capped list against a larger
// count reads as an honest "showing the top N" signal, never silent truncation. ORDER BY puts the
// contemporaneous, most-recent, highest-value contracts first, so the cap keeps the most relevant rows.
// ponytail: fixed cap, not pagination — add keyset paging only if a real winner exceeds this in practice.
export const LINK_CONTRACTS_LIMIT = 500;

// A winner's contracts by ЕИК — the read `loadLinkContracts` shares across every link on that winner
// (ydimitrof #312 HIGH 1 + 2). NO interest_links join and NO per-link gate: the set is a function of the ЕИК
// alone, and the callers pass only ALREADY-surfaced links (sealed() + the LINK_SELECT gate), so re-gating would
// be redundant. `temporal` is NOT computed here — it is per-link, derived client-side — so the same read serves
// every link on the winner. Binds are (ЕИК, unionLo, unionHi): the ORDER BY puts contracts whose signing year
// falls in the UNION of the winner's officials' declared windows FIRST, so the LINK_CONTRACTS_LIMIT cap can
// never drop an in-window contract (which would make a detail page read „0 in window" under a „X от Y" headline
// — the truth bug). NULL bounds (no declared window on any link) make the CASE fall through to signed_at DESC.
// The gated LINK_CONTRACTS_SQL below stays for the lazy route.
export const EIK_CONTRACTS_SQL = `SELECT cc.id, cc.signed_at, aa.name AS authority, aa.id AS authority_id,
    ath.spent_eur AS authority_total_eur, cc.contract_kind,
    cc.contract_number, cc.amount_eur,
    COALESCE(NULLIF(cc.contract_subject, ''), tt.title) AS subject,
    NULLIF(tt.procedure_type, 'неизвестна') AS procedure_type
  FROM bidders bb
    JOIN contracts cc ON cc.bidder_id = bb.id
    JOIN tenders tt ON tt.id = cc.tender_id
    JOIN authorities aa ON aa.id = tt.authority_id
    LEFT JOIN authority_totals ath ON ath.authority_id = aa.id
  WHERE bb.eik_normalized = ?
  ORDER BY
    (CASE WHEN cc.signed_at IS NOT NULL
            AND CAST(strftime('%Y', cc.signed_at) AS INTEGER) BETWEEN ? AND ?
          THEN 0 ELSE 1 END),
    cc.signed_at DESC, cc.amount_eur DESC
  LIMIT ${LINK_CONTRACTS_LIMIT}`;

// One published link's contracts, each marked against the declared-stake window. The WHERE gate reuses
// SURFACED_OWNERSHIP + NOT_REDUNDANT_FAMILY, so a non-surfaced link_key returns [] — a held/withdrawn/
// suppressed link, OR a family link collapsed by an own stake in the same winner, can never be enumerated
// through the drill-down. Marking mirrors classify.temporalStatus (min/max declared-year span) so the
// 'contemporaneous' rows here are exactly the subset counted by contemporaneous_contract_count above.
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
    AND ${SURFACED_OWNERSHIP}
    -- Same collapse as LINK_SELECT: a family link_key redundant with the official's own stake returns [] —
    -- the drill-down can never confirm a relative's stake the leaderboard collapsed away (de-anon oracle).
    AND ${NOT_REDUNDANT_FAMILY}
  ORDER BY (temporal = 'contemporaneous') DESC, cc.signed_at DESC, cc.amount_eur DESC
  LIMIT ${LINK_CONTRACTS_LIMIT}`;

/** The contracts of one published link, contemporaneous-first, each flagged in/out the declared window.
 *  Empty for an unknown or non-surfaced link_key (never leaks internal/held/withdrawn links). Kept as the
 *  gated single-link read for the standalone lazy route (`conflict.contracts.tsx`); the detail pages use the
 *  ЕИК-deduped `loadLinkContracts` instead. */
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
  return rows.map(toContract);
}
