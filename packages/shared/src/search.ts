// Search-term primitives shared by the FTS query builder (@sigma/db), the /search route, and the
// in-table list search UI, so they all agree on what counts as a „searchable" query — no drift.
// Pure string math, safe to bundle into the client.

export const MAX_QUERY_CHARS = 160;
export const MAX_QUERY_TOKENS = 8;
// Single-character `*`-prefix terms (e.g. „и*") match a huge slice of the FTS index, turning one
// request into a full-index COUNT + rank scan. Require ≥2 chars per term so a token actually narrows
// the postings list; shorter tokens are dropped, and a query with nothing left reads as empty.
export const MIN_QUERY_TOKEN_CHARS = 2;

/**
 * The letter/digit tokens of a query that survive the FTS filter: lowercased, ≥MIN_QUERY_TOKEN_CHARS
 * long, capped at MAX_QUERY_CHARS of input and MAX_QUERY_TOKENS terms. Punctuation is dropped.
 */
export function searchTokens(q: string): string[] {
  return (
    q
      .slice(0, MAX_QUERY_CHARS)
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((t) => t.length >= MIN_QUERY_TOKEN_CHARS)
      .slice(0, MAX_QUERY_TOKENS) ?? []
  );
}

/** True when a query yields at least one token the backend will actually MATCH on. */
export function hasSearchableTerms(q: string): boolean {
  return searchTokens(q).length > 0;
}
