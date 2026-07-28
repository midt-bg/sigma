import { describe, expect, it } from 'vitest';

import {
  ANNEX_EXPAND_SLACK,
  ANNEX_PREVIEW_CHARS,
  annexNeedsExpand,
  annexParagraphs,
  annexPreview,
  normalizeAnnexText,
} from './annexText';

describe('normalizeAnnexText', () => {
  it('collapses whitespace runs and trims', () => {
    expect(normalizeAnnexText('  Чл. 11\n\nсе  изменя\tтака:  ')).toBe('Чл. 11 се изменя така:');
  });
});

describe('annexParagraphs', () => {
  it('splits numbered amendment items followed by „Чл."', () => {
    const raw =
      '1.Чл.11 се изменя така: гаранционна поддръжка седем години. 2.  Чл. 16, ал. 3 се изменя така: ВЪЗЛОЖИТЕЛЯТ може да развали договора. III. Останалите клаузи не се изменят.';
    expect(annexParagraphs(raw)).toEqual([
      '1.Чл.11 се изменя така: гаранционна поддръжка седем години.',
      '2. Чл. 16, ал. 3 се изменя така: ВЪЗЛОЖИТЕЛЯТ може да развали договора.',
      'III. Останалите клаузи не се изменят.',
    ]);
  });

  it('splits on § paragraph markers', () => {
    const raw = '§ 1. Изменя се чл. 1, ал. 1. § 2. Изменя се чл. 7, ал. 1.';
    expect(annexParagraphs(raw)).toEqual([
      '§ 1. Изменя се чл. 1, ал. 1.',
      '§ 2. Изменя се чл. 7, ал. 1.',
    ]);
  });

  it('does not split on lowercase „чл." references mid-sentence', () => {
    const raw =
      'Гаранционният срок не може да е по-кратък от срока по чл. 20, ал. 4, т. 6 от Наредба № 2.';
    expect(annexParagraphs(raw)).toEqual([raw]);
  });
});

describe('annexPreview', () => {
  it('returns short text unchanged', () => {
    const raw = 'Изменя се чл. 7, ал. 1.';
    expect(annexPreview(raw)).toBe(raw);
    expect(annexNeedsExpand(raw)).toBe(false);
  });

  it('cuts long text at a word boundary with an ellipsis', () => {
    const raw = `${'Изменя се чл. 1, ал. 1, както следва: охранителни услуги за обектите '.repeat(8)}край`;
    const preview = annexPreview(raw);
    expect(annexNeedsExpand(raw)).toBe(true);
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(ANNEX_PREVIEW_CHARS + 2);
    expect(normalizeAnnexText(raw).startsWith(preview.slice(0, -1))).toBe(true);
    expect(preview.slice(0, -1).endsWith(' ')).toBe(false);
  });

  it('keeps text within the slack window un-expanded', () => {
    const raw = 'а'.repeat(ANNEX_PREVIEW_CHARS + ANNEX_EXPAND_SLACK);
    expect(annexPreview(raw)).toBe(raw);
    expect(annexNeedsExpand(raw)).toBe(false);
  });
});
