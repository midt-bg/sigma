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
    expect(searchTokens('мост 204918123')).toEqual(['мост', '204918123']);
  });

  it('drops a leading ЕИК/УНП/БУЛСТАТ label in front of a number', () => {
    expect(searchTokens('ЕИК 204918123')).toEqual(['204918123']);
    expect(searchTokens('ЕИК: 204918123')).toEqual(['204918123']);
    expect(searchTokens('унп 00044-2023-0018')).toEqual(['00044', '2023', '0018']);
    expect(searchTokens('Булстат 204918123')).toEqual(['204918123']);
    // A label alone, before a word, or later in the query is an ordinary term.
    expect(searchTokens('еик')).toEqual(['еик']);
    expect(searchTokens('еик мост')).toEqual(['еик', 'мост']);
    expect(searchTokens('мост еик 204918123')).toEqual(['мост', 'еик', '204918123']);
  });

  it('recomposes decomposed letters and drops stress marks instead of splitting the word', () => {
    expect(searchTokens('маи\u0306стор')).toEqual(['майстор']);
    expect(searchTokens('ремо\u0300нт')).toEqual(['ремонт']);
    expect(searchTokens('ремо\u0301нт')).toEqual(['ремонт']);
    expect(searchTokens('и\u0300 ѝзток')).toEqual(['изток']);
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
