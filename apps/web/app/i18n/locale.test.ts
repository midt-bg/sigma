import { describe, expect, it } from 'vitest';
import { getLocale, stripLocale, localizePath, swapLocalePath } from './locale';
import { makeT } from './t';

describe('getLocale', () => {
  it('defaults to bg for unprefixed paths', () => {
    expect(getLocale('/')).toBe('bg');
    expect(getLocale('/companies')).toBe('bg');
    expect(getLocale('/contracts/123')).toBe('bg');
  });

  it('detects en from the /en prefix', () => {
    expect(getLocale('/en')).toBe('en');
    expect(getLocale('/en/companies')).toBe('en');
    expect(getLocale('/en/contracts/123')).toBe('en');
  });

  it('does not treat /english or /enquiry as en', () => {
    expect(getLocale('/english')).toBe('bg');
    expect(getLocale('/enquiry')).toBe('bg');
  });

  it('accepts a full URL or a Request', () => {
    expect(getLocale('https://sigma.midt.bg/en/companies')).toBe('en');
    expect(getLocale(new Request('https://sigma.midt.bg/companies'))).toBe('bg');
  });
});

describe('stripLocale', () => {
  it('removes the en prefix down to the bg-rooted path', () => {
    expect(stripLocale('/en')).toBe('/');
    expect(stripLocale('/en/companies')).toBe('/companies');
    expect(stripLocale('/companies')).toBe('/companies');
    expect(stripLocale('/')).toBe('/');
  });
});

describe('localizePath', () => {
  it('leaves bg paths unprefixed', () => {
    expect(localizePath('/', 'bg')).toBe('/');
    expect(localizePath('/companies', 'bg')).toBe('/companies');
  });

  it('prefixes en paths', () => {
    expect(localizePath('/', 'en')).toBe('/en');
    expect(localizePath('/companies', 'en')).toBe('/en/companies');
  });

  it('re-targets an already-localized path instead of double-prefixing', () => {
    expect(localizePath('/en/companies', 'en')).toBe('/en/companies');
    expect(localizePath('/en/companies', 'bg')).toBe('/companies');
    expect(localizePath('/en', 'en')).toBe('/en');
  });
});

describe('swapLocalePath', () => {
  it('round-trips between locales preserving the page', () => {
    expect(swapLocalePath('/companies', 'en')).toBe('/en/companies');
    expect(swapLocalePath('/en/companies', 'bg')).toBe('/companies');
    expect(swapLocalePath('/', 'en')).toBe('/en');
    expect(swapLocalePath('/en', 'bg')).toBe('/');
  });

  it('is idempotent when the target locale already matches', () => {
    expect(swapLocalePath('/en/contracts/1', 'en')).toBe('/en/contracts/1');
    expect(swapLocalePath('/contracts/1', 'bg')).toBe('/contracts/1');
  });
});

describe('makeT', () => {
  it('resolves nested keys per locale', () => {
    expect(makeT('bg')('nav.home')).toBe('Начало');
    expect(makeT('en')('nav.home')).toBe('Home');
  });

  it('interpolates {name} placeholders', () => {
    expect(makeT('en')('footer.lastContract', { date: '14 Oct 2024' })).toBe(
      'latest contract 14 Oct 2024',
    );
    expect(makeT('en')('lang.switchTo', { lang: 'Български' })).toBe('Switch to Български');
  });
});
