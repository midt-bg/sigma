// Search — ranked FTS5 MATCH over the search_index, grouped by entity kind with per-group counts.
// The tokenizer folds case + diacritics (Cyrillic and Latin alike); we append `*` per token for
// „start-of-word" prefix matching, so „стр" finds „строителство", „Страбаг". УНП/ЕИК fragments work
// because the tokenizer splits them the same way on both sides.

import type { SearchHit, SearchResults } from '@sigma/api-contract';
import { hrefForEntity } from './identity';

type Kind = 'authority' | 'company' | 'contract';

const GROUPS: { kind: Kind; label: string; amountLabel: string; limit: number }[] = [
  { kind: 'authority', label: 'Институции', amountLabel: 'общо похарчено', limit: 6 },
  { kind: 'company', label: 'Компании', amountLabel: 'общо спечелено', limit: 6 },
  { kind: 'contract', label: 'Договори', amountLabel: 'стойност', limit: 6 },
];

/** Turn raw user input into an FTS5 prefix-AND query, or null if nothing searchable remains. */
function ftsQuery(q: string): string | null {
  const terms = q.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!terms || terms.length === 0) return null;
  return terms.map((t) => `${t}*`).join(' ');
}

interface HitRow {
  ref: string;
  title: string;
  ident: string | null;
  subtitle: string | null;
  amount: number | null;
}

export async function search(db: D1Database, rawQuery: string): Promise<SearchResults> {
  const query = (rawQuery ?? '').trim();
  const match = ftsQuery(query);
  if (!match) return { query, groups: [], empty: true };

  // Per-kind counts in one query.
  const countRows = await db
    .prepare(
      `SELECT kind, COUNT(*) AS n FROM search_index WHERE search_index MATCH ? GROUP BY kind`,
    )
    .bind(match)
    .all<{ kind: Kind; n: number }>();
  const counts = new Map(countRows.results.map((r) => [r.kind, r.n]));

  const groups = await Promise.all(
    GROUPS.map(async (g) => {
      const total = counts.get(g.kind) ?? 0;
      if (total === 0) return { kind: g.kind, label: g.label, total: 0, hits: [], moreHref: null };
      const { results } = await db
        .prepare(
          `SELECT ref, title, ident, subtitle, amount FROM search_index
           WHERE kind = ? AND search_index MATCH ? ORDER BY rank LIMIT ?`,
        )
        .bind(g.kind, match, g.limit)
        .all<HitRow>();
      const hits: SearchHit[] = results.map((r) => ({
        kind: g.kind,
        slug: hrefForEntity(g.kind, r.ref).split('/').pop()!,
        href: hrefForEntity(g.kind, r.ref),
        title: r.title,
        ident: r.ident || null,
        subtitle: r.subtitle || null,
        amountEur: r.amount,
        amountLabel: g.amountLabel,
      }));
      return { kind: g.kind, label: g.label, total, hits, moreHref: null };
    }),
  );

  return { query, groups, empty: groups.every((g) => g.total === 0) };
}
