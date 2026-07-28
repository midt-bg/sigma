import { describe, expect, it } from 'vitest';
import {
  hasSearchableTerms,
  MAX_QUERY_CHARS,
  MAX_QUERY_TOKENS,
  MIN_QUERY_TOKEN_CHARS,
  searchTokens,
} from './search';

describe('searchTokens', () => {
  it('lowercases and splits on non-letter/digit runs, dropping punctuation', () => {
    expect(searchTokens('Мост ЕООД, гр. София')).toEqual(['мост', 'еоод', 'гр', 'софия']);
  });

  it('drops tokens shorter than MIN_QUERY_TOKEN_CHARS', () => {
    // Single-char `*`-prefix terms scan a huge slice of the FTS index — they must not reach MATCH.
    expect(MIN_QUERY_TOKEN_CHARS).toBe(2);
    expect(searchTokens('а и в мост')).toEqual(['мост']);
  });

  it('returns no tokens for punctuation- or single-char-only queries', () => {
    expect(searchTokens('!!! ?')).toEqual([]);
    expect(searchTokens('я')).toEqual([]);
  });

  it('caps the number of tokens at MAX_QUERY_TOKENS', () => {
    const q = Array.from({ length: MAX_QUERY_TOKENS + 5 }, (_, i) => `дума${i}`).join(' ');
    expect(searchTokens(q)).toHaveLength(MAX_QUERY_TOKENS);
  });

  it('caps the scanned input at MAX_QUERY_CHARS before tokenizing', () => {
    // A token whose first char sits past the cap is never seen.
    const padded = `${'a'.repeat(MAX_QUERY_CHARS)} мост`;
    expect(searchTokens(padded)).not.toContain('мост');
  });

  it('keeps digit tokens', () => {
    expect(searchTokens('ЕИК 204918123')).toEqual(['еик', '204918123']);
  });
});

describe('hasSearchableTerms', () => {
  it('is false when nothing survives the FTS filter', () => {
    expect(hasSearchableTerms('')).toBe(false);
    expect(hasSearchableTerms('   ')).toBe(false);
    expect(hasSearchableTerms('.,!')).toBe(false);
    expect(hasSearchableTerms('я')).toBe(false);
  });

  it('is true once a token of MIN_QUERY_TOKEN_CHARS or more survives', () => {
    expect(hasSearchableTerms('мост')).toBe(true);
    expect(hasSearchableTerms('я мост')).toBe(true);
  });
});
