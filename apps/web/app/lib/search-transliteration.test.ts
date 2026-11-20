import { describe, expect, it } from 'vitest';
import { cyrillicSuggestion, latinWordToCyrillic } from './search-transliteration';

// The Cyrillic reading /search offers for a Latin query that found nothing. A fixed table, longest letter
// group first; identifiers, addresses and Cyrillic are never rewritten.
describe('latinWordToCyrillic', () => {
  it('reads a name typed in Latin', () => {
    expect(latinWordToCyrillic('zoraluma')).toBe('зоралума');
    expect(latinWordToCyrillic('Petrov')).toBe('петров');
  });

  it('reads the letter groups before the single letters', () => {
    expect(latinWordToCyrillic('shtastie')).toBe('щастие'); // sht, not s+h+t or sh+t
    expect(latinWordToCyrillic('zhelezo')).toBe('железо'); // zh
    expect(latinWordToCyrillic('cherven')).toBe('червен'); // ch
    expect(latinWordToCyrillic('shose')).toBe('шосе'); // sh
    expect(latinWordToCyrillic('tsvetya')).toBe('цветя'); // ts, ya
    expect(latinWordToCyrillic('yunak')).toBe('юнак'); // yu
    expect(latinWordToCyrillic('bulgaria')).toBe('булгария'); // a final „ia" is „ия"
  });

  it('has no reading for a letter the table does not hold', () => {
    expect(latinWordToCyrillic('quantum')).toBeNull();
  });
});

describe('cyrillicSuggestion', () => {
  it('suggests the Cyrillic query, in lower case', () => {
    expect(cyrillicSuggestion('zoraluma')).toBe('зоралума');
    expect(cyrillicSuggestion('Test Grup EOOD')).toBe('тест груп еоод');
  });

  it('suggests nothing for a query already in Cyrillic', () => {
    expect(cyrillicSuggestion('зоралума')).toBeNull();
    expect(cyrillicSuggestion('тест груп')).toBeNull();
  });

  it('leaves the homoglyph case to search: a word with a Cyrillic letter is kept as typed', () => {
    expect(cyrillicSuggestion('мoст')).toBeNull(); // a Latin „o" inside a Cyrillic word
  });

  it('never rewrites numbers or identifiers', () => {
    expect(cyrillicSuggestion('103267194')).toBeNull(); // ЕИК
    expect(cyrillicSuggestion('00044-2023-0018')).toBeNull(); // УНП
    expect(cyrillicSuggestion('T446583')).toBeNull(); // a letter-and-digits identifier
    expect(cyrillicSuggestion('2024')).toBeNull();
  });

  it('keeps identifiers and numbers beside a Latin word, and reads only the word', () => {
    expect(cyrillicSuggestion('remont 2024')).toBe('ремонт 2024');
    expect(cyrillicSuggestion('stroy 103267194')).toBe('строй 103267194');
  });

  it('never rewrites an address', () => {
    expect(cyrillicSuggestion('https://example.bg')).toBeNull();
    expect(cyrillicSuggestion('www.example.bg')).toBeNull();
    expect(cyrillicSuggestion('office@example.bg')).toBeNull();
    expect(cyrillicSuggestion('example.bg')).toBeNull();
  });

  it('suggests nothing when a Latin word has no full reading', () => {
    expect(cyrillicSuggestion('quantum')).toBeNull();
    expect(cyrillicSuggestion('remont quantum')).toBeNull();
  });

  it('suggests nothing for an empty query or one letter', () => {
    expect(cyrillicSuggestion('')).toBeNull();
    expect(cyrillicSuggestion('   ')).toBeNull();
    expect(cyrillicSuggestion('a')).toBeNull();
  });
});
