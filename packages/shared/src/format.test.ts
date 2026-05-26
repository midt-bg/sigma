import { describe, expect, it } from 'vitest';
import {
  contractValue,
  count,
  date,
  entityName,
  longDate,
  money,
  monthYear,
  pct,
  periodRange,
  signedPct,
} from './format';

describe('money', () => {
  it('tiers EUR with Bulgarian magnitudes and decimal comma', () => {
    expect(money(640)).toBe('640 €');
    expect(money(412_000)).toBe('412 хил. €');
    expect(money(187_000_000)).toBe('187 млн. €');
    expect(money(123_600_000)).toBe('123,6 млн. €');
    expect(money(50_840_000_000)).toBe('50,8 млрд. €'); // ≥10 млрд → one decimal
    expect(money(4_576_000_000)).toBe('4,58 млрд. €'); //  <10 млрд → two decimals
    expect(money(1_200_000_000)).toBe('1,20 млрд. €'); // keeps the trailing zero under 10
  });
  it('rounds at tier boundaries without overflowing a tier', () => {
    expect(money(999)).toBe('999 €');
    expect(money(1000)).toBe('1 хил. €');
  });
  it('suppresses absent values rather than printing 0', () => {
    expect(money(null)).toBe('—');
    expect(money(undefined)).toBe('—');
  });
  it('keeps a sign for negative deltas', () => {
    expect(money(-1500)).toBe('−2 хил. €');
  });
});

describe('count / pct', () => {
  it('groups thousands with a space', () => {
    expect(count(190_429)).toBe('190 429');
    expect(count(17_448)).toBe('17 448');
    expect(count(7)).toBe('7');
  });
  it('formats ratios as percentages, dropping a trailing ,0', () => {
    expect(pct(0.453)).toBe('45,3%');
    expect(pct(0.78)).toBe('78%');
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
