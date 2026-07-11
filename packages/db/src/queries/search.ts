// Search — ranked FTS5 MATCH over the search_index, grouped by entity kind with per-group counts.
// The tokenizer folds case + diacritics (Cyrillic and Latin alike); we append `*` per token for
// „start-of-word" prefix matching, so „стр" finds „строителство", „Страбаг". УНП/ЕИК fragments work
// because the tokenizer splits them the same way on both sides.

import type { EntityKind, OwnershipKind, SearchHit, SearchResults } from '@sigma/api-contract';
import { cleanName, entityName, parseConsortiumMembers, searchTokens } from '@sigma/shared';
import { hrefForEntity } from './identity';

export type SearchKind = 'official' | 'authority' | 'company' | 'contract';

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
  // Свързани лица (declared conflict-of-interest officials). Placed first here, but only actually LEADS the
  // results when it's the strongest match — see the relevance gate in search(). The minister's ask: a name
  // search must surface the person's declared-conflict profile.
  {
    kind: 'official',
    label: 'Свързани лица',
    amountLabel: 'по договори',
    limit: 6,
    path: '/conflicts',
  },
  {
    kind: 'authority',
    label: 'Институции',
    amountLabel: 'общо похарчено',
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

const CYRILLIC = /[\p{Script=Cyrillic}]/u;

function deHomoglyph(q: string): string {
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
  has_conflict: number | null; // 1 when a company row has a published свързани-лица link (badge)
  rank: number; // FTS bm25 score (lower = better); the group's top row gives its best rank for the gate
}

// One group's ranked hits. Company rows additionally carry a свързани-лица flag: a LEFT JOIN against the
// published conflict links keyed on the winner's ЕИК (= the company row's `ident`). Published-only,
// private/family ownership — the same gate as the /conflicts surface, so search can never flag a company the
// surface wouldn't. Binds: kind, match, limit. Exported so search-sql.test runs the EXACT SQL (not a copy).
export const SEARCH_HITS_SQL = `SELECT search_index.ref, search_index.title, search_index.ident,
        search_index.subtitle, search_index.amount, rank,
        ct.kind AS entity_kind, ct.ownership_kind, ct.eik_valid,
        (cf.eik IS NOT NULL) AS has_conflict
 FROM search_index
 LEFT JOIN company_totals ct
   ON search_index.kind = 'company' AND ct.bidder_id = search_index.ref
 LEFT JOIN (
   SELECT DISTINCT eik FROM interest_links
   WHERE status = 'published' AND interest_class IN ('private_ownership', 'family_ownership')
 ) cf ON search_index.kind = 'company' AND cf.eik = search_index.ident
 WHERE search_index.kind = ? AND search_index MATCH ?
 ORDER BY rank LIMIT ?`;

export async function search(db: D1Database, rawQuery: string): Promise<SearchResults> {
  const query = (rawQuery ?? '').trim();
  const match = searchMatchQuery(query);
  // No searchable content (empty, or punctuation-only like a lone „"") → empty-query shape, with the
  // term normalized to '' so the page falls back to the generic „Търсене" header instead of echoing
  // the stray punctuation in the H1.
  if (!match) return { query: '', groups: [], empty: true };

  // Per-kind counts in one query.
  const countRows = await db
    .prepare(
      `SELECT kind, COUNT(*) AS n FROM search_index WHERE search_index MATCH ? GROUP BY kind`,
    )
    .bind(match)
    .all<{ kind: SearchKind; n: number }>();
  const counts = new Map(countRows.results.map((r) => [r.kind, r.n]));

  const built = await Promise.all(
    GROUPS.map(async (g) => {
      const total = counts.get(g.kind) ?? 0;
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
        };
      }
      const { results } = await db
        .prepare(SEARCH_HITS_SQL)
        .bind(g.kind, match, g.limit)
        .all<HitRow>();
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
          ident: r.ident || null,
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
        group: {
          kind: g.kind,
          label: g.label,
          total,
          hits,
          moreHref: total > hits.length ? searchMoreHref(g.kind, query) : null,
        },
        // Best (lowest bm25) rank in the group = its top row, for the relevance gate below.
        bestRank: results.length ? results[0]!.rank : Infinity,
      };
    }),
  );

  // Placement (the minister's ask): „Свързани лица" LEADS — but only when it is genuinely the strongest
  // match, never on an incidental prefix hit. When its best rank ties or beats every other non-empty group
  // it goes first; otherwise it sinks to last (still shown, just not hijacking the top over a stronger
  // company/contract match). Empty groups are hidden downstream, so „first when matched, absent otherwise"
  // falls out for free.
  const official = built.find((b) => b.group.kind === 'official')!;
  const rest = built.filter((b) => b.group.kind !== 'official');
  const bestOther = Math.min(Infinity, ...rest.map((b) => b.bestRank));
  const officialLeads = official.group.total > 0 && official.bestRank <= bestOther;
  const groups = (officialLeads ? [official, ...rest] : [...rest, official]).map((b) => b.group);

  return { query, groups, empty: groups.every((g) => g.total === 0) };
}
