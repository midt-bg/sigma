// Search — ranked FTS5 MATCH over the search_index, grouped by entity kind with per-group counts.
// The tokenizer folds case + diacritics (Cyrillic and Latin alike); we append `*` per token for
// „start-of-word" prefix matching, so „стр" finds „строителство", „Страбаг". УНП/ЕИК fragments work
// because the tokenizer splits them the same way on both sides.

import type { EntityKind, OwnershipKind, SearchHit, SearchResults } from '@sigma/api-contract';
import {
  cleanName,
  companyNameStem,
  describeOffices,
  entityName,
  officesLine,
  allOfficesFormer,
  parseConsortiumMembers,
  searchTokens,
  type OfficeFiling,
} from '@sigma/shared';
import { hrefForEntity } from './identity';

export type SearchKind = 'official' | 'person' | 'authority' | 'company' | 'contract';

// The tokenizer and its caps live in @sigma/shared so the FTS query builder and the search UI agree
// on what counts as searchable. Re-exported here for existing @sigma/db consumers.
export { MAX_QUERY_CHARS, MAX_QUERY_TOKENS, MIN_QUERY_TOKEN_CHARS } from '@sigma/shared';

const GROUPS: {
  kind: SearchKind;
  label: string;
  amountLabel: string;
  limit: number;
  path: string;
}[] = [
  // Officials with a published stake. Searched apart from the other people (its own index kind and its own
  // „виж всички" list), then shown with them as ONE group, „Лица" — see peopleGroup() in search().
  {
    kind: 'official',
    label: 'Лица',
    // The index holds the list's „стойност в периода на длъжността" (the officials block of precompute.sql),
    // and the row says so: a bare sum beside a name reads as every contract of the person's companies.
    amountLabel: 'по договори в периода на длъжността',
    limit: 6,
    path: '/conflicts',
  },
  // Everyone else with a page: declarants without a published stake and people the Trade Register records.
  // No listing page, so no „виж всички". Shown inside „Лица" with the officials; each row's gutter label still
  // says whether the person is a длъжностно лице (kindLabel, apps/web/app/lib/search-labels.ts).
  { kind: 'person', label: 'Лица', amountLabel: '', limit: 6, path: '' },
  {
    kind: 'authority',
    label: 'Институции',
    amountLabel: 'възложено общо',
    limit: 6,
    path: '/authorities',
  },
  {
    kind: 'company',
    label: 'Компании',
    amountLabel: 'общо спечелено',
    limit: 6,
    path: '/companies',
  },
  { kind: 'contract', label: 'Договори', amountLabel: 'стойност', limit: 6, path: '/contracts' },
];

// Common Latin↔Cyrillic confusables (homoglyphs). People paste names where a few Cyrillic letters
// got typed on a Latin keyboard, e.g. „Стрoителствo" with a Latin o — which otherwise matches
// nothing. We map only the well-known confusable set, and only on the search term (never on stored
// data). Case-sensitive: e.g. Latin `B` looks like Cyrillic `В`, but lowercase `b` has no twin.
const HOMOGLYPHS: Record<string, string> = {
  a: 'а',
  c: 'с',
  e: 'е',
  o: 'о',
  p: 'р',
  x: 'х',
  y: 'у',
  k: 'к',
  m: 'м',
  t: 'т',
  A: 'А',
  B: 'В',
  C: 'С',
  E: 'Е',
  H: 'Н',
  K: 'К',
  M: 'М',
  O: 'О',
  P: 'Р',
  T: 'Т',
  X: 'Х',
};

export const CYRILLIC = /[\p{Script=Cyrillic}]/u;

export function deHomoglyph(q: string): string {
  return q.replace(/[aceopxykmtABCEHKMOPTX]/g, (ch) => HOMOGLYPHS[ch] ?? ch);
}

/** Turn raw user input into an FTS5 prefix-AND query, or null if nothing searchable remains.
 *  Homoglyph-swap is applied per-term and only when the term already contains at least one
 *  Cyrillic letter — that's the „I meant Cyrillic but typed a stray Latin o" case. A pure-Latin
 *  term like „ALSTOM" passes through untouched, otherwise its Latin a/o/t/m would be swapped to
 *  Cyrillic and the resulting mixed-script token would match nothing in the index. */
export function searchMatchQuery(q: string): string | null {
  const terms = searchTokens(q);
  if (terms.length === 0) return null;
  return terms.map((t) => `${CYRILLIC.test(t) ? deHomoglyph(t) : t}*`).join(' ');
}

export function searchMoreHref(kind: SearchKind, query: string): string {
  const group = GROUPS.find((g) => g.kind === kind);
  const params = new URLSearchParams({ q: query });
  return `${group?.path ?? '/search'}?${params.toString()}`;
}
interface HitRow {
  ref: string;
  title: string;
  ident: string | null;
  subtitle: string | null;
  amount: number | null;
  entity_kind: EntityKind | null;
  ownership_kind: OwnershipKind | null;
  eik_valid: number | null;
  has_conflict: number | null; // 1 when a company row has a published свързани-лица link — self or family (badge)
  rank: number; // FTS bm25 score (lower = better); the group's top row gives its best rank for the gate
}

// One row of the ranked read: a hit, the kind it belongs to, its place in that kind and the kind's count.
interface RankedRow extends HitRow {
  kind: SearchKind;
  n: number; // every match of this kind, the group's total
  rn: number; // 1-based place within the kind, by rank
}

// bm25 alone ties a company with consortium strings and name-keyed fragments that carry the same words,
// so the canonical company could drop out of the six shown. Company hits are drawn from a wider pool of
// the best-ranked rows and re-ordered: the name equal to the query (legal form and quotes aside) first,
// then rows with a valid ЕИК, then bm25.
const COMPANY_POOL = 50;

// How many ranked rows each kind brings back: the group's own limit, the wider pool for companies.
const poolSize = (g: (typeof GROUPS)[number]): number =>
  g.kind === 'company' ? COMPANY_POOL : g.limit;

// The свързани-лица badge on a company row: a published self OR family stake on the winner's ЕИК (= the
// company row's `ident`), backed by a Trade Register evidence SEAL, AND the winner must have LIVE contracts
// (the same read-time N9 gate LINK_SELECT applies), so search flags exactly the companies the /conflicts
// surface shows and never one whose page would 404. A family-only winner badges — the /conflicts page
// already publishes that link by name, so the badge discloses nothing the surface doesn't.
//
// The seal EXISTS clause is the same one SURFACED_OWNERSHIP applies (related-persons.ts), and it belongs
// here for a sharper reason than symmetry: search is the WIDER surface. A published row whose seal is
// missing or withholding — a legacy row, a partial run, a loader bug — would badge a свързани-лица claim
// about a named official to every searcher, while the page behind the badge correctly showed nothing.
// Four copies of this predicate now exist (here, SURFACED_OWNERSHIP, precompute.sql, refresh-slice.sql);
// related-persons-sql.test.ts pins them to each other.
//
// Asked per company row actually returned (at most COMPANY_POOL), through the (eik, status) index, rather
// than by materialising every badged ЕИК for each request.
const CONFLICT_BADGE = `EXISTS (
         SELECT 1 FROM interest_links il
         WHERE il.eik = si.ident AND il.status = 'published'
           AND il.interest_class IN ('private_ownership', 'family_ownership')
           AND EXISTS (SELECT 1 FROM interest_link_evidence e
                       WHERE e.link_key = il.link_key AND e.evidence_kind IN ('document','confirmed'))
           AND EXISTS (SELECT 1 FROM contracts cc JOIN bidders bb ON bb.id = cc.bidder_id
                       WHERE bb.eik_normalized = il.eik))`;

// Every group in ONE read of the full-text index. The window ranks each kind's matches once and counts
// them in the same pass; only each kind's best `poolSize` rows are joined back for their display columns.
// It replaces a COUNT … GROUP BY kind plus one `kind = ? … ORDER BY rank LIMIT ?` statement per kind, each
// of which re-ranked every match — and a rare kind (the officials) walked the whole ranked list of a short
// prefix to find its six. Ties in bm25 are common (contracts with the same subject); `rowid` breaks them
// the way those per-kind statements did, so the same rows come back. Binds: match.
//
// Built with or without the badge. The badge reads BOTH свързани-лица migrations — interest_links (0003)
// and interest_link_evidence (0006) — and on an env where either is unapplied it would make the ENTIRE
// search 500 with „no such table". search() detects both tables once per request and picks the no-badge
// variant when either is absent, so search degrades to has_conflict=0 rather than breaking (ADR-0031
// robustness ask). Exported so search-sql.test runs the EXACT SQL (not a copy).
const rankedSql = (withConflict: boolean): string => `WITH ranked AS (
  SELECT rowid AS rid, kind, rank,
         ROW_NUMBER() OVER (PARTITION BY kind ORDER BY rank, rowid) AS rn,
         COUNT(*) OVER (PARTITION BY kind) AS n
  FROM search_index WHERE search_index MATCH ?
)
SELECT ranked.kind, ranked.n, ranked.rn, ranked.rank,
       si.ref, si.title, si.ident, si.subtitle, si.amount,
       ct.kind AS entity_kind, ct.ownership_kind, ct.eik_valid,
       ${withConflict ? `CASE WHEN ranked.kind = 'company' THEN ${CONFLICT_BADGE} ELSE 0 END` : '0'} AS has_conflict
FROM ranked
JOIN search_index si ON si.rowid = ranked.rid
LEFT JOIN company_totals ct ON ranked.kind = 'company' AND ct.bidder_id = si.ref
WHERE ranked.rn <= CASE ranked.kind ${GROUPS.map((g) => `WHEN '${g.kind}' THEN ${poolSize(g)}`).join(' ')} ELSE 0 END
ORDER BY ranked.kind, ranked.rn`;

function rankCompanies(rows: HitRow[], query: string): HitRow[] {
  const stem = companyNameStem(query);
  const key = (r: HitRow) =>
    (stem && companyNameStem(r.title) === stem ? 0 : 2) + (r.eik_valid === 1 ? 0 : 1);
  return [...rows].sort((a, b) => key(a) - key(b)); // stable: bm25 order within a tier
}

export const SEARCH_RANKED_SQL = rankedSql(true);
export const SEARCH_RANKED_SQL_NO_CONFLICT = rankedSql(false);

export async function search(db: D1Database, rawQuery: string): Promise<SearchResults> {
  const query = (rawQuery ?? '').trim();
  const match = searchMatchQuery(query);
  // No searchable content (empty, or punctuation-only like a lone „"") → empty-query shape, with the
  // term normalized to '' so the page falls back to the generic „Търсене" header instead of echoing
  // the stray punctuation in the H1.
  if (!match) return { query: '', groups: [], empty: true };

  // Pick the ranked SQL once: on an env where the свързани-лица migrations are not applied, the badge
  // would 500 the whole search — fall back to the no-badge variant (has_conflict=0) instead.
  //
  // BOTH tables are required, not just interest_links: the badge also reads interest_link_evidence
  // (0006), so an env with 0003 but not 0006 would break every search on every kind. Requiring both also
  // gives the right answer on such an env — with no seal table nothing is provably sealed, so nothing
  // should badge.
  const hasConflictTable =
    (
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('interest_links','interest_link_evidence')",
        )
        .first<{ n: number }>()
    )?.n === 2;

  const { results: ranked } = await db
    .prepare(hasConflictTable ? SEARCH_RANKED_SQL : SEARCH_RANKED_SQL_NO_CONFLICT)
    .bind(match)
    .all<RankedRow>();
  const byKind = new Map<SearchKind, RankedRow[]>();
  for (const r of ranked) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);

  const built = GROUPS.map((g) => {
    const pool = (byKind.get(g.kind) ?? []).sort((a, b) => a.rn - b.rn).slice(0, poolSize(g));
    const total = pool[0]?.n ?? 0;
    if (total === 0) {
      return {
        group: {
          kind: g.kind,
          label: g.label,
          total: 0,
          hits: [] as SearchHit[],
          moreHref: null,
        },
        bestRank: Infinity,
        refs: [] as string[],
      };
    }
    const isCompanyGroup = g.kind === 'company';
    const results = isCompanyGroup ? rankCompanies(pool, query).slice(0, g.limit) : pool;
    const hits: SearchHit[] = results.map((r) => {
      const href = hrefForEntity(g.kind, r.ref);
      const isCompany = g.kind === 'company';
      const companyKind = r.entity_kind ?? 'company';
      const isConsortium = isCompany && companyKind === 'consortium';
      const membership = isConsortium ? parseConsortiumMembers(r.title) : null;
      const memberCount = membership?.kind === 'list' ? membership.members.length : null;
      const hasEik = isCompany ? r.eik_valid === 1 && Boolean(r.ident) : undefined;
      return {
        kind: g.kind,
        slug: href.split('/').pop()!,
        href,
        title: isCompany ? entityName(cleanName(r.title), companyKind) : r.title,
        ident: g.kind === 'official' || g.kind === 'person' ? null : r.ident || null,
        ...(isCompany
          ? {
              isConsortium,
              hasEik,
              ownershipKind: r.ownership_kind,
              memberCount,
              hasConflict: r.has_conflict === 1,
            }
          : {}),
        subtitle: r.subtitle || null,
        amountEur: r.amount,
        amountLabel: g.amountLabel,
      };
    });
    return {
      refs: results.map((r) => r.ref),
      group: {
        kind: g.kind,
        label: g.label,
        total,
        hits,
        moreHref: total > hits.length && g.path ? searchMoreHref(g.kind, query) : null,
      },
      // Best (lowest bm25) rank in the group = its top row, for the relevance gate below.
      bestRank: pool[0]!.rank,
    };
  });

  const people = await peopleGroup(
    db,
    built.find((x) => x.group.kind === 'official')!,
    built.find((x) => x.group.kind === 'person')!,
  );
  // Placement (the minister's ask): the people LEAD — but only when they are genuinely the strongest match,
  // never on an incidental prefix hit. When their best rank ties or beats every other non-empty group they go
  // first; otherwise they sink to last (still shown, just not hijacking the top over a stronger
  // company/contract match). Empty groups are hidden downstream, so „first when matched, absent otherwise"
  // falls out for free.
  const rest = built.filter((b) => b.group.kind !== 'official' && b.group.kind !== 'person');
  const bestOther = Math.min(Infinity, ...rest.map((b) => b.bestRank));
  const leads = people.group.total > 0 && people.bestRank <= bestOther;
  const groups = (leads ? [people, ...rest] : [...rest, people]).map((b) => b.group);

  return { query, groups, empty: groups.every((g) => g.total === 0) };
}

type BuiltGroup = { group: SearchResults['groups'][number]; bestRank: number; refs: string[] };

// A registry person's ref is the 64-hex indent; everyone else in the people kinds is a declarant.
const REGISTRY_REF = /^[0-9a-f]{64}$/;

/**
 * The two people kinds as ONE group, „Лица": officials with a published stake first, then everyone else with
 * a page. Each declarant's line is their offices by the one rule (`describeOffices`): position, institution,
 * the years with filings and „бивш" only with an exit declaration nothing reopens. A registry-only person
 * keeps the index's line (their companies). „Виж всички" leads to the officials' list only while every match
 * is in it.
 */
async function peopleGroup(
  db: D1Database,
  official: BuiltGroup,
  person: BuiltGroup,
): Promise<BuiltGroup> {
  const hits = [...official.group.hits, ...person.group.hits];
  const refs = [...official.refs, ...person.refs];
  const declarants = [...new Set(refs.filter((r) => !REGISTRY_REF.test(r)))];
  if (declarants.length) {
    try {
      const { results } = await db
        .prepare(
          `SELECT d.person_id, d.institution, d.position, d.declared_year AS year,
             m.declaration_type AS type, m.declared_on AS declaredOn
           FROM declarations d LEFT JOIN declaration_metadata m ON m.declaration_id = d.id
           WHERE d.person_id IN (SELECT value FROM json_each(?))`,
        )
        .bind(JSON.stringify(declarants))
        .all<OfficeFiling & { person_id: string }>();
      const byPerson = new Map<string, OfficeFiling[]>();
      for (const r of results) byPerson.set(r.person_id, [...(byPerson.get(r.person_id) ?? []), r]);
      hits.forEach((hit, i) => {
        const offices = describeOffices(byPerson.get(refs[i]!) ?? []);
        const line = officesLine(offices);
        if (line) hit.subtitle = line;
        if (allOfficesFormer(offices)) hit.formerOfficial = true;
      });
    } catch {
      // An env without the declarations tables keeps the index's own line.
    }
  }
  return {
    refs,
    group: {
      kind: 'official',
      label: 'Лица',
      total: official.group.total + person.group.total,
      hits,
      moreHref: person.group.total === 0 ? official.group.moreHref : null,
    },
    bestRank: Math.min(official.bestRank, person.bestRank),
  };
}
