import { describe, expect, it } from 'vitest';
import { companyNameKey, isMatchableKey } from './company-name-key';

// The libel proof. Fixture rows are labelled by `companyId` (the real-world entity).
// PROPERTY: no normalized key may span two distinct companyId values (zero over-merge).
// Rows sharing a companyId are the SAME фирма written differently → they MUST share a key.
// Rows with different companyId are DISTINCT фирми → they MUST NOT share a key.
//
// Bulgarian trade names are nationally unique on the FULL фирма (incl. legal form), so the
// normalizer folds only presentation noise (case, whitespace, quote glyphs) and preserves every
// legally-distinguishing token. It must NOT transliterate Cyrillic↔Latin, fold и/&, strip
// branch/ЕТ tokens, or drop the legal form.

interface Fixture {
  raw: string;
  companyId: string;
}

const FIXTURES: Fixture[] = [
  // --- SAME entity, presentation-only differences → must share a key ---
  { raw: '"ДЕМИР АГРО" ЕООД', companyId: 'demir-agro' },
  { raw: '„ДЕМИР АГРО" ЕООД', companyId: 'demir-agro' }, // curly/guillemet quotes
  { raw: 'демир агро еоод', companyId: 'demir-agro' }, // lowercase, no quotes
  { raw: 'ДЕМИР   АГРО    ЕООД', companyId: 'demir-agro' }, // extra whitespace
  { raw: 'СОФАРМА ТРЕЙДИНГ "АД"', companyId: 'sofarma-trading' },
  { raw: 'СОФАРМА ТРЕЙДИНГ" АД', companyId: 'sofarma-trading' }, // space-before-form quirk
  { raw: 'ДЕТСКА ГРАДИНА "ЗДРАВЕЦ"', companyId: 'dg-zdravec' },
  { raw: 'ДЕТСКА ГРАДИНА ЗДРАВЕЦ', companyId: 'dg-zdravec' }, // same, unquoted

  // --- DISTINCT entities that a careless normalizer would merge → must NOT share a key ---
  // form-only difference (national uniqueness hinges on the form token)
  { raw: 'АЛФА ЕООД', companyId: 'alfa-eood' },
  { raw: 'АЛФА ООД', companyId: 'alfa-ood' },
  { raw: 'АЛФА АД', companyId: 'alfa-ad' },
  // ordinal / distinguishing token
  { raw: 'СТРОЙ 1', companyId: 'stroy-1' },
  { raw: 'СТРОЙ 2', companyId: 'stroy-2' },
  // и vs & — a real distinguishing glyph, never folded
  { raw: 'ИВАН И СИН ООД', companyId: 'ivan-i-sin' },
  { raw: 'ИВАН & СИН ООД', companyId: 'ivan-amp-sin' },
  // ЕТ personal-name sole traders — same person prefix, different firm
  { raw: 'ЕТ ИВАН ПЕТРОВ', companyId: 'et-ivan-petrov' },
  { raw: 'ЕТ ИВАН ПЕТРОВ - ЕВРОТРЕЙД', companyId: 'et-ivan-petrov-evrotreyd' },
  // branch (клон) — a branch can carry its own registration
  { raw: 'ГЛОБУС ЕООД', companyId: 'globus-eood' },
  { raw: 'ГЛОБУС ЕООД - КЛОН ПЛОВДИВ', companyId: 'globus-eood-klon-plovdiv' },
  // punctuation-only form variant: conservative — we do NOT strip punctuation, so keys differ
  // (a safe recall miss, never an over-merge)
  { raw: 'БЕТА ООД', companyId: 'beta-ood-plain' },
  { raw: 'БЕТА О.О.Д.', companyId: 'beta-ood-dotted' },
  // Cyrillic vs Latin homoglyph — must never transliterate-merge
  { raw: 'АЛФА ЕООД', companyId: 'alfa-eood' }, // all-Cyrillic (dup of alfa-eood on purpose)
  { raw: 'AЛФA ЕООД', companyId: 'alfa-latin-homoglyph' }, // Latin A's — distinct codepoints
  // inner quote separates tokens — dropping it (АБ"ВГ→АБВГ) would collide with a genuinely distinct АБВГ
  { raw: 'АБ"ВГ ООД', companyId: 'ab-vg-inner-quote' },
  { raw: 'АБВГ ООД', companyId: 'abvg-plain' },
];

describe('companyNameKey', () => {
  it('is a pure, stable function (same input → same output)', () => {
    for (const { raw } of FIXTURES) {
      expect(companyNameKey(raw)).toBe(companyNameKey(raw));
    }
  });

  it('gives every row of the SAME entity one shared key', () => {
    const byCompany = new Map<string, Set<string>>();
    for (const { raw, companyId } of FIXTURES) {
      const key = companyNameKey(raw);
      (byCompany.get(companyId) ?? byCompany.set(companyId, new Set()).get(companyId)!).add(key);
    }
    for (const [companyId, keys] of byCompany) {
      expect(
        keys,
        `company ${companyId} split across keys: ${[...keys].join(' | ')}`,
      ).toHaveProperty('size', 1);
    }
  });

  // THE LIBEL GATE — computed generically over all pairs, so adding a fixture row can never
  // silently stop protecting: no key may belong to two distinct companyId values.
  it('never merges two distinct entities into one key (0 over-merge)', () => {
    const byKey = new Map<string, Set<string>>();
    for (const { raw, companyId } of FIXTURES) {
      const key = companyNameKey(raw);
      (byKey.get(key) ?? byKey.set(key, new Set()).get(key)!).add(companyId);
    }
    const overMerges = [...byKey.entries()]
      .filter(([, ids]) => ids.size > 1)
      .map(([key, ids]) => `${key} ⇐ ${[...ids].join(', ')}`);
    expect(overMerges, `over-merged keys:\n${overMerges.join('\n')}`).toEqual([]);
  });

  it('preserves the legal-form token (АЛФА ЕООД ≠ АЛФА АД)', () => {
    expect(companyNameKey('АЛФА ЕООД')).not.toBe(companyNameKey('АЛФА АД'));
    expect(companyNameKey('АЛФА ЕООД')).not.toBe(companyNameKey('АЛФА ООД'));
  });

  it('does not transliterate Cyrillic↔Latin homoglyphs', () => {
    expect(companyNameKey('АЛФА ЕООД')).not.toBe(companyNameKey('AЛФA ЕООД'));
  });

  it('does not fold и and & ', () => {
    expect(companyNameKey('ИВАН И СИН ООД')).not.toBe(companyNameKey('ИВАН & СИН ООД'));
  });

  it('maps an inner quote to a separator, not a deletion (АБ"ВГ ≠ АБВГ)', () => {
    // The regression: `.replace(/"/g,'')` merged `АБ"ВГ`→`АБВГ`, colliding with a distinct `АБВГ`.
    expect(companyNameKey('АБ"ВГ')).toBe('АБ ВГ');
    expect(companyNameKey('АБ"ВГ')).not.toBe(companyNameKey('АБВГ'));
    // surrounding quotes still fold away (they collapse at the trim/whitespace step)
    expect(companyNameKey('"АЛФА" ЕООД')).toBe('АЛФА ЕООД');
  });

  describe('isMatchableKey — the empty-key over-merge guard', () => {
    it('is false for degenerate input that folds to the empty key', () => {
      for (const raw of ['', '   ', '""', '„"', '  " "  ']) {
        expect(companyNameKey(raw), `raw=${JSON.stringify(raw)}`).toBe('');
        expect(isMatchableKey(companyNameKey(raw)), `raw=${JSON.stringify(raw)}`).toBe(false);
      }
    });
    it('is true for any real name', () => {
      for (const raw of ['АЛФА ЕООД', 'СТРОЙ 1', 'ЕТ ИВАН ПЕТРОВ']) {
        expect(isMatchableKey(companyNameKey(raw)), raw).toBe(true);
      }
    });
  });
});
