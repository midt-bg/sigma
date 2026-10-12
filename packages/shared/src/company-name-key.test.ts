import { describe, expect, it } from 'vitest';
import {
  companyNameKey,
  companyNamesAlike,
  declaredNameMatches,
  declaredTextHasEik,
  filingsNameCompany,
  isMatchableKey,
  registryCompanyName,
} from './company-name-key';

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

describe('companyNamesAlike', () => {
  it('reads the register name and the declared spelling as one company', () => {
    expect(companyNamesAlike('НАДЕЖДА ГЛОБАЛ', 'Надежда Глобал ЕООД')).toBe(true);
    expect(companyNamesAlike('ТЕСТИЛОН - ПЪРВИ С-ИЕ', 'Тестилон-Първи с-ие СД')).toBe(true);
    expect(companyNamesAlike('ИВА - ИВАН ИВАНОВ', 'ЕТ „Ива – Иван Иванов“')).toBe(true);
    expect(companyNamesAlike('ЕПСИЛОН ИНЖЕНЕРИНГ', 'Епсилон Инжинеринг ЕООД')).toBe(true);
    expect(companyNamesAlike('СТЕНАТА', 'CTEHATA ООД')).toBe(true);
  });
  it('keeps distinct firms apart, however similar', () => {
    expect(companyNamesAlike('ТЕСТИЛОН', 'Тестилон-А ООД')).toBe(false);
    expect(companyNamesAlike('ТЕСТИЛОН', 'Тестилон - Първи с-ие СД')).toBe(false);
    expect(companyNamesAlike('АЛФА', 'АЛМА ЕООД')).toBe(false);
    expect(companyNamesAlike('', 'АЛФА')).toBe(false);
  });
});

describe('registryCompanyName', () => {
  it('spells the legal form the register keeps as a code', () => {
    expect(registryCompanyName('НАДЕЖДА ГЛОБАЛ', 'EOOD')).toBe('НАДЕЖДА ГЛОБАЛ ЕООД');
    expect(registryCompanyName('ИВА - ИВАН ИВАНОВ', 'ET')).toBe('ЕТ ИВА - ИВАН ИВАНОВ');
    expect(registryCompanyName('АЛФА ООД', 'OOD')).toBe('АЛФА ООД');
    expect(registryCompanyName('АЛФА', 'CC')).toBe('АЛФА');
    expect(registryCompanyName('АЛФА', null)).toBe('АЛФА');
  });
});

describe('declaredNameMatches', () => {
  it('reads a legal form glued to the name, and a note in brackets, as the same company', () => {
    expect(declaredNameMatches('ТЕСТ ГРУПЕООД', 'ТЕСТ ГРУП')).toBe(true);
    expect(declaredNameMatches('„Тест Груп" ООД (без дейност от 2004 г.)', 'ТЕСТ ГРУП')).toBe(true);
  });

  it('counts one name contained whole in the other, so a note never rests on a near miss', () => {
    expect(declaredNameMatches('Медицински център Тестмед ЕООД', 'ТЕСТМЕД')).toBe(true);
    expect(declaredNameMatches('ПРИМЕР 97 ООД', 'ПРИМЕР')).toBe(true);
  });

  it('keeps a word that merely starts like the company apart, and a too-short name exact', () => {
    expect(declaredNameMatches('ПРИМЕРНО СТРОИТЕЛСТВО ЕООД', 'ПРИМЕР')).toBe(false);
    expect(declaredNameMatches('ТСТ ТРЕЙД ООД', 'ТСТ')).toBe(false);
  });

  it('names nothing from a blank entry', () => {
    expect(declaredNameMatches('', 'ТЕСТ ГРУП')).toBe(false);
    expect(declaredNameMatches('ЕООД', 'ТЕСТ ГРУП')).toBe(false);
  });
});

describe('declaredTextHasEik', () => {
  it('finds the ЕИК written into an entry, spaces and all, but not inside a longer number', () => {
    expect(declaredTextHasEik('ТЕСТ ГРУП ЕООД, ЕИК 123456789', '123456789')).toBe(true);
    expect(declaredTextHasEik('ЕИК: 123 456 789', '123456789')).toBe(true);
    expect(declaredTextHasEik('сметка 91234567890', '123456789')).toBe(false);
    expect(declaredTextHasEik('ЕИК 123456789', 'not-an-eik')).toBe(false);
  });
});

describe('filingsNameCompany', () => {
  const company = { eik: '123456789', names: ['ТЕСТ ГРУП', null, 'СТАРО ИМЕ'] };

  it('takes a resolved ЕИК, the ЕИК in the text, the current name or a former one', () => {
    expect(filingsNameCompany({ eiks: ['123456789'], named: [] }, company)).toBe(true);
    expect(filingsNameCompany({ eiks: [], named: ['ЕИК 123456789'] }, company)).toBe(true);
    expect(filingsNameCompany({ eiks: [], named: ['"Тест груп" ЕООД'] }, company)).toBe(true);
    expect(filingsNameCompany({ eiks: [], named: ['Старо Име ООД'] }, company)).toBe(true);
  });

  it('says no only when nothing in the filings resembles the company', () => {
    expect(filingsNameCompany({ eiks: ['987654321'], named: ['ДРУГА ФИРМА ООД'] }, company)).toBe(
      false,
    );
  });
});
