// Search-term primitives shared by the FTS query builder (@sigma/db), the /search route, and the
// in-table list search UI, so they all agree on what counts as a „searchable" query — no drift.
// Pure string math, safe to bundle into the client.

export const MAX_QUERY_CHARS = 160;
export const MAX_QUERY_TOKENS = 8;
// Single-character `*`-prefix terms (e.g. „и*") match a huge slice of the FTS index, turning one
// request into a full-index COUNT + rank scan. Require ≥2 chars per term so a token actually narrows
// the postings list; shorter tokens are dropped, and a query with nothing left reads as empty.
export const MIN_QUERY_TOKEN_CHARS = 2;

// The label a registry extract prints before the number („ЕИК 175405647", „УНП 00044-2023-0018").
// Every term is AND-ed, so a label left in the query would have to occur in the record itself.
const ID_LABELS = new Set(['еик', 'унп', 'булстат']);

/**
 * The letter/digit tokens of a query that survive the FTS filter: lowercased, ≥MIN_QUERY_TOKEN_CHARS
 * long, capped at MAX_QUERY_CHARS of input and MAX_QUERY_TOKENS terms. Punctuation is dropped.
 *
 * Text pasted from macOS file names, PDFs or chat apps can arrive decomposed (и + U+0306 for „й") or
 * with stress marks (U+0300/U+0301). A combining mark is not a letter, so it would cut the word in
 * two: stress marks are dropped and the rest recomposed (NFC) before the word split. A leading
 * ЕИК/УНП/БУЛСТАТ label in front of a number is dropped too.
 */
export function searchTokens(q: string): string[] {
  const tokens =
    q
      .slice(0, MAX_QUERY_CHARS)
      .normalize('NFD')
      .replace(/[\u0300\u0301]/g, '')
      .normalize('NFC')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((t) => t.length >= MIN_QUERY_TOKEN_CHARS) ?? [];
  if (ID_LABELS.has(tokens[0] ?? '') && /^\d/.test(tokens[1] ?? '')) tokens.shift();
  return tokens.slice(0, MAX_QUERY_TOKENS);
}

/** True when a query yields at least one token the backend will actually MATCH on. */
export function hasSearchableTerms(q: string): boolean {
  return searchTokens(q).length > 0;
}
