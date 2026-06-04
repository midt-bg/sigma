import { describe, expect, it } from 'vitest';
import {
  cleanName,
  contractValue,
  count,
  date,
  entityName,
  longDate,
  money,
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

describe('count / pct', () => {
  it('groups thousands with a non-breaking space', () => {
    expect(count(190_429)).toBe(`190${NBSP}429`);
    expect(count(17_448)).toBe(`17${NBSP}448`);
    expect(count(7)).toBe('7');
  });
  it('formats ratios as percentages, dropping a trailing ,0', () => {
    expect(pct(0.453)).toBe('45,3%');
    expect(pct(0.78)).toBe('78%');
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

describe('entityName / contractValue', () => {
  it('collapses a consortium member list to first + „и др."', () => {
    expect(entityName('МЕДЕКС ООД; АЛТА ФАРМАСЮТИКЪЛС ООД; ЕКОФАРМ ЕООД', 'consortium')).toBe(
      'МЕДЕКС ООД и др.',
    );
  });
  it('passes company names through as source truth', () => {
    expect(entityName('"СОФАРМА ТРЕЙДИНГ "АД', 'company')).toBe('"СОФАРМА ТРЕЙДИНГ "АД');
  });
  it('returns amount_eur, or null for a suspect/unconvertible row', () => {
    expect(contractValue({ amount_eur: 98_700_000 })).toBe(98_700_000);
    expect(contractValue({ amount_eur: null })).toBeNull();
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
