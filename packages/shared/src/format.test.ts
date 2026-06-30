import { describe, expect, it } from 'vitest';
import {
  cleanName,
  count,
  date,
  entityName,
  isNaturalPersonBidder,
  isNaturalPersonProfileName,
  longDate,
  MASKED_NATURAL_PERSON_LABEL,
  money,
  moneyBare,
  monthYear,
  pct,
  periodRange,
  plural,
  parseConsortiumMembers,
  signedPct,
} from './format';

const NBSP = ' '; // count()/money() use a non-breaking space so figures never wrap

describe('money', () => {
  it('tiers EUR with Bulgarian magnitudes and decimal comma', () => {
    expect(money(640)).toBe(`640${NBSP}€`);
    expect(money(412_000)).toBe(`412${NBSP}хил.${NBSP}€`);
    expect(money(187_000_000)).toBe(`187${NBSP}млн.${NBSP}€`);
    expect(money(4.58e9)).toBe(`4,58${NBSP}млрд.${NBSP}€`);
    expect(money(50.8e9)).toBe(`50,8${NBSP}млрд.${NBSP}€`);
    expect(money(123_600_000)).toBe(`123,6${NBSP}млн.${NBSP}€`);
    expect(money(50_840_000_000)).toBe(`50,8${NBSP}млрд.${NBSP}€`); // ≥10 млрд → one decimal
    expect(money(4_576_000_000)).toBe(`4,58${NBSP}млрд.${NBSP}€`); //  <10 млрд → two decimals
    expect(money(1_200_000_000)).toBe(`1,20${NBSP}млрд.${NBSP}€`); // keeps the trailing zero under 10
  });
  it('rounds at tier boundaries without overflowing a tier', () => {
    expect(money(999)).toBe(`999${NBSP}€`);
    expect(money(999.4)).toBe(`999${NBSP}€`);
    expect(money(999.6)).toBe(`1${NBSP}хил.${NBSP}€`);
    expect(money(1000)).toBe(`1${NBSP}хил.${NBSP}€`);
    expect(money(9.996e9)).toBe(`10${NBSP}млрд.${NBSP}€`);
  });
  it('suppresses absent values rather than printing 0', () => {
    expect(money(null)).toBe('—');
    expect(money(undefined)).toBe('—');
    expect(money(NaN)).toBe('—');
  });
  it('does not emit signed zero', () => {
    expect(money(-0.3)).toBe(`0${NBSP}€`);
    expect(money(0)).toBe(`0${NBSP}€`);
  });
  it('keeps a sign for negative deltas', () => {
    expect(money(-1500)).toBe(`−2${NBSP}хил.${NBSP}€`);
  });
});

describe('moneyBare', () => {
  it('formats like money() but without the trailing € unit', () => {
    expect(moneyBare(640)).toBe('640');
    expect(moneyBare(412_000)).toBe(`412${NBSP}хил.`);
    expect(moneyBare(187_000_000)).toBe(`187${NBSP}млн.`);
    expect(moneyBare(4.58e9)).toBe(`4,58${NBSP}млрд.`);
  });
  it('returns a dash for absent values', () => {
    expect(moneyBare(null)).toBe('—');
    expect(moneyBare(undefined)).toBe('—');
    expect(moneyBare(NaN)).toBe('—');
  });
  it('keeps a sign for negative values', () => {
    expect(moneyBare(-1500)).toBe(`−2${NBSP}хил.`);
  });
});

describe('count / pct', () => {
  it('groups thousands with a non-breaking space', () => {
    expect(count(190_429)).toBe(`190${NBSP}429`);
    expect(count(17_448)).toBe(`17${NBSP}448`);
    expect(count(7)).toBe('7');
  });
  it('formats ratios as percentages, dropping a trailing ,0', () => {
    expect(pct(0.453)).toBe('45,3%');
    expect(pct(0.78)).toBe('78%');
    expect(pct(-0.233)).toBe('−23,3%');
    expect(pct(-0.0001)).toBe('0%');
    expect(signedPct(0)).toBe('0%');
    expect(signedPct(0.0001)).toBe('0%');
    expect(signedPct(-0.0001)).toBe('0%');
    expect(signedPct(-0.233)).toBe('−23,3%');
    expect(signedPct(0.05)).toBe('+5%');
  });
});

describe('dates', () => {
  it('formats ISO dates in Bulgarian forms without Intl', () => {
    expect(date('2024-10-14')).toBe('14.10.2024');
    expect(monthYear('2024-10-14')).toBe('октомври 2024');
    expect(longDate('2024-10-01')).toBe('1 октомври 2024 г.');
    expect(periodRange('2020-07-03', '2026-05-20')).toBe('юли 2020 — май 2026');
  });
  it('returns a dash for missing dates', () => {
    expect(date(null)).toBe('—');
  });
});

describe('entityName', () => {
  it('collapses a consortium member list to first + „и др."', () => {
    expect(entityName('МЕДЕКС ООД; АЛТА ФАРМАСЮТИКЪЛС ООД; ЕКОФАРМ ЕООД', 'consortium')).toBe(
      'МЕДЕКС ООД и др.',
    );
  });
  it('passes company names through as source truth', () => {
    expect(entityName('"СОФАРМА ТРЕЙДИНГ "АД', 'company')).toBe('"СОФАРМА ТРЕЙДИНГ "АД');
  });
});

describe('plural', () => {
  it('picks the Bulgarian count word (1, 21 → singular; 11, 2, 17 → plural)', () => {
    expect(plural(1, 'договор', 'договора')).toBe('договор');
    expect(plural(21, 'договор', 'договора')).toBe('договор');
    expect(plural(11, 'договор', 'договора')).toBe('договора'); // 11 is the exception
    expect(plural(2, 'съвпадение', 'съвпадения')).toBe('съвпадения');
    expect(plural(17, 'съвпадение', 'съвпадения')).toBe('съвпадения');
    expect(plural(0, 'съвпадение', 'съвпадения')).toBe('съвпадения');
  });
});

describe('cleanName', () => {
  it('hugs a closing quote to the word before a legal-form suffix', () => {
    expect(cleanName('"СОФАРМА ТРЕЙДИНГ "АД')).toBe('"СОФАРМА ТРЕЙДИНГ" АД');
  });
  it('unifies curly/guillemet double-quotes to straight', () => {
    expect(cleanName('„СОФАРМА ТРЕЙДИНГ" ЕАД')).toBe('"СОФАРМА ТРЕЙДИНГ" ЕАД');
    expect(cleanName('«ЛУКОЙЛ»')).toBe('"ЛУКОЙЛ"');
  });
  it('is a conservative no-op on already-clean names', () => {
    expect(cleanName('ДЕТСКА ГРАДИНА "ЗДРАВЕЦ"')).toBe('ДЕТСКА ГРАДИНА "ЗДРАВЕЦ"');
    expect(cleanName('СОФАРМА ТРЕЙДИНГ АД')).toBe('СОФАРМА ТРЕЙДИНГ АД');
    expect(cleanName('ФИРМА "АДАМ" ООД')).toBe('ФИРМА "АДАМ" ООД');
  });
  it('trims and never throws', () => {
    expect(cleanName('  тест  ')).toBe('тест');
  });
});

describe('parseConsortiumMembers', () => {
  it('parses a clean semicolon-separated member list', () => {
    const parsed = parseConsortiumMembers('A ООД; B ЕООД; C АД');
    expect(parsed?.kind).toBe('list');
    expect(parsed?.kind === 'list' ? parsed.members : []).toHaveLength(3);
  });

  it('returns null for a single name', () => {
    expect(parseConsortiumMembers('Едно ООД')).toBeNull();
  });

  it('keeps prose strings intact', () => {
    expect(parseConsortiumMembers('съдружници са следните лица')).toEqual({
      kind: 'prose',
      raw: 'съдружници са следните лица',
    });
  });

  it('returns null for an empty string', () => {
    expect(parseConsortiumMembers('')).toBeNull();
  });

  it('dedupes repeated members', () => {
    const parsed = parseConsortiumMembers('A; A; B');
    expect(parsed).toEqual({ kind: 'list', members: ['A', 'B'] });
  });
});

describe('isNaturalPersonProfileName', () => {
  it('detects sole-trader names that embed a natural person', () => {
    expect(isNaturalPersonProfileName('ЕТ ДРИФТ - НИКОЛАЙ КИРОВ')).toBe(true);
  });

  it('does not flag ordinary company names', () => {
    expect(isNaturalPersonProfileName('СОФАРМА ТРЕЙДИНГ АД')).toBe(false);
  });
});

describe('isNaturalPersonBidder', () => {
  it('flags a sole-trader legal form even when the name has no ЕТ prefix (legal_form rule wins)', () => {
    expect(isNaturalPersonBidder('Some Company OOOD', 'ЕТ')).toBe(true);
  });

  it('flags the Latin-script ET legal form', () => {
    expect(isNaturalPersonBidder('ET DRIFT', 'ET')).toBe(true);
  });

  it('flags expanded sole-trader legal forms', () => {
    expect(isNaturalPersonBidder('Some Trader', 'ЕДНОЛИЧЕН ТЪРГОВЕЦ')).toBe(true);
    expect(isNaturalPersonBidder('Some Trader', 'SOLE TRADER')).toBe(true);
    expect(isNaturalPersonBidder('Some Trader', 'INDIVIDUAL')).toBe(true);
  });

  it('does not flag ordinary company legal forms', () => {
    expect(isNaturalPersonBidder('СОФАРМА ТРЕЙДИНГ', 'ООД')).toBe(false);
    expect(isNaturalPersonBidder('СОФАРМА ТРЕЙДИНГ', 'ЕАД')).toBe(false);
  });

  it('returns false for a legal-entity bidder (АД)', () => {
    expect(isNaturalPersonBidder('СОФАРМА ТРЕЙДИНГ', 'АД')).toBe(false);
  });

  it('falls back to the leading-ЕТ name heuristic when legal_form is null', () => {
    expect(isNaturalPersonBidder('ЕТ Пример', null)).toBe(true);
  });

  it('falls back to the leading-ET (Latin) name heuristic when legal_form does not match', () => {
    expect(isNaturalPersonBidder('ET Example', 'unknown')).toBe(true);
  });

  it('returns false for a consortium whose legal_form is ДЗЗД and name has no ЕТ prefix', () => {
    expect(isNaturalPersonBidder('Обединение', 'ДЗЗД')).toBe(false);
  });

  it('returns false for a plain company with a non-matching legal form and no ЕТ prefix', () => {
    expect(isNaturalPersonBidder('СОФАРМА ТРЕЙДИНГ', 'АД')).toBe(false);
  });
});

describe('MASKED_NATURAL_PERSON_LABEL', () => {
  it('is a non-empty string', () => {
    expect(typeof MASKED_NATURAL_PERSON_LABEL).toBe('string');
    expect(MASKED_NATURAL_PERSON_LABEL.length).toBeGreaterThan(0);
  });

  it('is not the verbatim sole-trader name it replaces', () => {
    expect(MASKED_NATURAL_PERSON_LABEL).not.toBe('ЕТ ДРИФТ - НИКОЛАЙ КИРОВ');
  });

  it('is safe to render as JSON / HTML and as a CSV cell (no comma, no quote)', () => {
    expect(MASKED_NATURAL_PERSON_LABEL).not.toMatch(/[,"]/);
  });
});

/**
 * End-to-end smoke for the shared predicate surface.
 *
 * `isNaturalPersonBidder` and `isNaturalPersonProfileName` are the SINGLE source of truth for the
 * noindex / masking decision that every downstream flow depends on — F2 (CSV masking in
 * `streamContractsCsv` / `streamCompaniesCsv`), F3 (JSON masking in `/contracts/:id.json`), and F4
 * (the privacy doc). If the two helpers drift apart, a sole-trader / natural-person identifier
 * would leak either through search indexing or through a machine-readable body — exactly the
 * regression this block guards against.
 *
 * The masking label referenced below is the same `MASKED_NATURAL_PERSON_LABEL` constant that F2
 * and F3 substitute for `contractor_eik` / `eik` / `contractor` / `bidder.name` /
 * `sourceNames.bidder`. Importing it here pins the test contract to the runtime masker so a
 * future rename in `format.ts` cannot silently desynchronize them.
 */
describe('shared predicate surface — single source of truth for the noindex / masking decision', () => {
  it('agrees between isNaturalPersonBidder (legal_form rule) and isNaturalPersonProfileName (name heuristic) for a sole trader', () => {
    // legal_form rule: ЕТ alone is enough to flag the bidder as a natural person
    expect(isNaturalPersonBidder('Sole', 'ЕТ')).toBe(true);
    // name heuristic: the leading-ЕТ marker on the display name reaches the same verdict
    expect(isNaturalPersonProfileName('ЕТ Sole')).toBe(true);
    // Both helpers must classify their respective inputs as a natural person — no drift.
  });

  it('agrees between the two helpers for a legal entity (both return false)', () => {
    expect(isNaturalPersonBidder('Acme', 'ООД')).toBe(false);
    expect(isNaturalPersonProfileName('Acme')).toBe(false);
  });

  it('returns the documented natural-person verdict for a six-pair truth table', () => {
    const truthTable: ReadonlyArray<{
      name: string;
      legalForm: string | null;
      naturalPerson: boolean;
    }> = [
      { name: 'Sole', legalForm: 'ЕТ', naturalPerson: true }, // legal_form rule wins
      { name: 'ЕТ Leading Name', legalForm: null, naturalPerson: true }, // name heuristic fallback
      { name: 'Some Trader', legalForm: 'ЕДНОЛИЧЕН ТЪРГОВЕЦ', naturalPerson: true }, // expanded sole-trader form
      { name: 'Acme', legalForm: 'ООД', naturalPerson: false }, // ordinary ООД
      { name: 'СОФАРМА ТРЕЙДИНГ', legalForm: 'АД', naturalPerson: false }, // ordinary АД
      { name: 'Обединение', legalForm: 'ДЗЗД', naturalPerson: false }, // consortium — not a sole trader
    ];

    for (const { name, legalForm, naturalPerson } of truthTable) {
      expect(
        isNaturalPersonBidder(name, legalForm),
        `isNaturalPersonBidder(${JSON.stringify(name)}, ${JSON.stringify(legalForm)})`,
      ).toBe(naturalPerson);
    }

    // The masking label used by F2 / F3 must remain the same constant exported from this package.
    // If a downstream caller ever drifts onto a different label, this assertion surfaces it here.
    expect(typeof MASKED_NATURAL_PERSON_LABEL).toBe('string');
    expect(MASKED_NATURAL_PERSON_LABEL.length).toBeGreaterThan(0);
    expect(MASKED_NATURAL_PERSON_LABEL).not.toBe('Sole');
  });
});
