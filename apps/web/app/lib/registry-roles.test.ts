// The Trade Register's roles in words: in full in a sentence, short on an edge, and past once every role ended.
import { describe, expect, it } from 'vitest';
import { ROLE_LABEL, joinWords, roleEdgeText, roleSentence } from './registry-roles';

describe('joinWords', () => {
  it('joins as Bulgarian does', () => {
    expect(joinWords([])).toBe('');
    expect(joinWords(['а'])).toBe('а');
    expect(joinWords(['а', 'б'])).toBe('а и б');
    expect(joinWords(['а', 'б', 'в'])).toBe('а, б и в');
  });
});

describe('a role tie in words', () => {
  it('names the roles in full in a sentence, and short on an edge', () => {
    const e = { roles: ['manager' as const, 'board_of_directors' as const], current: true };
    expect(roleSentence(e)).toBe('управител и член на съвета на директорите');
    expect(roleEdgeText(e)).toBe('управител и СД');
  });

  it('says when every role has ended', () => {
    const e = { roles: ['manager' as const], current: false };
    expect(roleSentence(e)).toBe('бивш управител');
    expect(roleEdgeText(e)).toBe('бивш управител');
  });

  it('keeps an edge short however many roles it carries', () => {
    expect(
      roleEdgeText({
        roles: ['manager', 'representative', 'procurator', 'partner'],
        current: true,
      }),
    ).toBe('управител, представител +2');
  });

  it('has words for every role the register records', () => {
    expect(Object.keys(ROLE_LABEL)).toHaveLength(15);
    expect(ROLE_LABEL.beneficial_owner).toBe('действителен собственик');
  });
});
