import { describe, expect, it } from 'vitest';
import { meta as competitionMeta } from './competition';
import { meta as mapMeta } from './map';
import { meta as trendsMeta } from './trends';

const matches = [{ id: 'root', data: { origin: 'https://example.test' } }];

describe('analysis pages meta', () => {
  it.each([
    ['/competition', competitionMeta],
    ['/map', mapMeta],
    ['/trends', trendsMeta],
  ] as const)('%s carries a canonical URL without filters and Open Graph tags', (path, meta) => {
    const tags = meta({ matches } as never) as Record<string, unknown>[];
    expect(tags).toContainEqual({
      tagName: 'link',
      rel: 'canonical',
      href: `https://example.test${path}`,
    });
    expect(tags.some((t) => t.property === 'og:title')).toBe(true);
  });
});
