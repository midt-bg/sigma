import { describe, expect, it } from 'vitest';
import {
  cleanName,
  count,
  date,
  eik,
  entityName,
  isNaturalPersonProfileName,
  longDate,
  money,
  moneyBare,
  monthYear,
  pct,
  periodRange,
  plural,
  parseConsortiumMembers,
  signedMoney,
  signedPct,
  unp,
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
  it('signs monetary deltas like signedPct (+ positive, U+2212 negative, no sign on zero)', () => {
    expect(signedMoney(187_000_000)).toBe(`+187${NBSP}млн.`);
    expect(signedMoney(-187_000_000)).toBe(`−187${NBSP}млн.`);
    expect(signedMoney(640)).toBe('+640');
    expect(signedMoney(-640)).toBe('−640');
    expect(signedMoney(0)).toBe(moneyBare(0)); // no sign on zero
    expect(signedMoney(null)).toBe('—');
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

  it('accepts the latin ET spelling and requires the trailing space', () => {
    expect(isNaturalPersonProfileName('ET DRIFT')).toBe(true);
    expect(isNaturalPersonProfileName('  ет дрифт  ')).toBe(true); // trims + upcases first
    expect(isNaturalPersonProfileName('ЕТАЖ ООД')).toBe(false); // "ЕТ" without the space is not a prefix
  });
});

describe('count (sign and absence branches)', () => {
  it('signs negatives with U+2212 and groups thousands', () => {
    expect(count(-1234)).toBe(`−1${NBSP}234`);
    expect(count(-7)).toBe('−7');
  });
  it('rounds to the nearest integer before grouping', () => {
    expect(count(0)).toBe('0');
    expect(count(1234.6)).toBe(`1${NBSP}235`);
    expect(count(1234.4)).toBe(`1${NBSP}234`);
  });
  it('returns a dash for absent or non-finite values', () => {
    expect(count(null)).toBe('—');
    expect(count(undefined)).toBe('—');
    expect(count(NaN)).toBe('—');
    expect(count(Infinity)).toBe('—');
  });
});

describe('pct / signedPct (dp, absence, and precision branches)', () => {
  it('returns a dash for absent or non-finite ratios', () => {
    expect(pct(null)).toBe('—');
    expect(pct(undefined)).toBe('—');
    expect(pct(NaN)).toBe('—');
    expect(signedPct(null)).toBe('—');
    expect(signedPct(Infinity)).toBe('—');
  });
  it('honours an explicit decimal-places argument', () => {
    expect(pct(0.12345, 2)).toBe('12,35%'); // rounds at 2 dp
    expect(pct(0.789, 0)).toBe('79%'); // 0 dp
    expect(signedPct(0.12345, 2)).toBe('+12,35%');
    expect(signedPct(-0.12345, 2)).toBe('−12,35%');
  });
});

describe('dates (fallback and tolerance branches)', () => {
  it('tolerates a datetime suffix on date()/longDate()', () => {
    expect(date('2024-10-14T09:30:00Z')).toBe('14.10.2024');
    expect(longDate('2024-10-01T00:00:00')).toBe('1 октомври 2024 г.');
  });
  it('passes an unparseable string through verbatim', () => {
    expect(date('не е дата')).toBe('не е дата');
    expect(date('2024/10/14')).toBe('2024/10/14'); // needs dashes
    expect(monthYear('няма')).toBe('няма');
    expect(longDate('няма')).toBe('няма');
  });
  it('falls back to the raw month number when it is out of range', () => {
    // MONTHS_BG[12] is undefined → the `?? m[2]` guard keeps the digits, never "undefined".
    expect(monthYear('2024-13')).toBe('13 2024');
    expect(longDate('2024-00-05')).toBe('5 00 2024 г.');
  });
  it('returns a dash for missing month/long dates', () => {
    expect(monthYear(null)).toBe('—');
    expect(monthYear(undefined)).toBe('—');
    expect(longDate(null)).toBe('—');
  });
});

describe('periodRange', () => {
  it('joins two present endpoints', () => {
    expect(periodRange('2020-07-03', '2026-05-20')).toBe('юли 2020 — май 2026');
  });
  it('collapses to the single present endpoint', () => {
    expect(periodRange('2020-07-03', null)).toBe('юли 2020');
    expect(periodRange(null, '2026-05-20')).toBe('май 2026');
    expect(periodRange('2020-07-03', undefined)).toBe('юли 2020');
  });
  it('returns a dash when both endpoints are absent', () => {
    expect(periodRange(null, null)).toBe('—');
    expect(periodRange(undefined, undefined)).toBe('—');
    expect(periodRange('', '')).toBe('—');
  });
});

describe('eik / unp passthrough', () => {
  it('trims a present value and returns empty string for absent', () => {
    expect(eik('  831634121  ')).toBe('831634121');
    expect(eik(null)).toBe('');
    expect(eik(undefined)).toBe('');
    expect(eik('')).toBe('');
    expect(unp('  00073-2024-0012  ')).toBe('00073-2024-0012');
    expect(unp(null)).toBe('');
    expect(unp('')).toBe('');
  });
});

describe('entityName (non-collapsing branches)', () => {
  it('passes a consortium name without a member separator through unchanged', () => {
    expect(entityName('ЕДНО ОБЕДИНЕНИЕ ДЗЗД', 'consortium')).toBe('ЕДНО ОБЕДИНЕНИЕ ДЗЗД');
  });
  it('does not collapse a company name even when it contains a semicolon', () => {
    expect(entityName('A; B', 'company')).toBe('A; B');
  });
  it('falls through when the first member segment is empty', () => {
    expect(entityName('; ВТОРО ООД', 'consortium')).toBe('; ВТОРО ООД');
  });
});

describe('cleanName (unbalanced-quote branch)', () => {
  it('drops a single leading unbalanced quote', () => {
    expect(cleanName('"ФИРМА ООД')).toBe('ФИРМА ООД');
  });
  it('drops a single trailing unbalanced quote', () => {
    expect(cleanName('ФИРМА ООД"')).toBe('ФИРМА ООД');
  });
  it('leaves a balanced pair of quotes intact', () => {
    expect(cleanName('"ЛУКОЙЛ"')).toBe('"ЛУКОЙЛ"');
  });
});
