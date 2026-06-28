import { describe, expect, it } from 'vitest';
import { cacheKey } from './cache-key';

function cacheUrl(input: string): URL {
  return new URL(cacheKey(new Request(input), 'deploy-test').url);
}

describe('cacheKey', () => {
  it('drops junk params and keeps the deploy tag', () => {
    const url = cacheUrl('http://local/companies?zqjunk123=1');

    expect(url.pathname).toBe('/companies');
    expect([...url.searchParams]).toEqual([['_dt', 'deploy-test']]);
  });

  it('keeps known params and drops unknown params', () => {
    const url = cacheUrl('http://local/contracts?year=2024&unknown=1&sort=value-desc&q=test');

    expect([...url.searchParams]).toEqual([
      ['q', 'test'],
      ['sort', 'value-desc'],
      ['year', '2024'],
      ['_dt', 'deploy-test'],
    ]);
  });

  it('preserves multi-values for allowed params', () => {
    const url = cacheUrl('http://local/companies?sector=45&kind=company&sector=72');

    expect(url.searchParams.getAll('sector')).toEqual(['45', '72']);
    expect([...url.searchParams]).toEqual([
      ['kind', 'company'],
      ['sector', '45'],
      ['sector', '72'],
      ['_dt', 'deploy-test'],
    ]);
  });

  it('canonicalizes known param order', () => {
    const first = cacheUrl('http://local/authorities?year=2024&type=municipality&eu=eu');
    const second = cacheUrl('http://local/authorities?eu=eu&year=2024&type=municipality');

    expect(first.search).toBe('?eu=eu&type=municipality&year=2024&_dt=deploy-test');
    expect(second.search).toBe(first.search);
  });

  it('canonicalizes percent-encoded path variants', () => {
    const encoded = cacheUrl('http://local/contracts/e%3AUNP-1%3ACONTRACT-1');
    const decoded = cacheUrl('http://local/contracts/e:UNP-1:CONTRACT-1');

    expect(encoded.toString()).toBe(decoded.toString());
    expect(encoded.pathname).toBe('/contracts/e:UNP-1:CONTRACT-1');
  });

  it('keeps genuinely distinct paths distinct', () => {
    const first = cacheUrl('http://local/contracts/e:UNP-1:CONTRACT-1');
    const second = cacheUrl('http://local/contracts/e:UNP-1:CONTRACT-2');

    expect(first.toString()).not.toBe(second.toString());
  });

  it('falls back to the raw pathname for malformed percent-encoding', () => {
    expect(() => cacheUrl('http://local/contracts/%')).not.toThrow();
    expect(cacheUrl('http://local/contracts/%').pathname).toBe('/contracts/%');
  });
});
