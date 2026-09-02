// The свързани-лица routes' cache policy, tested at the export rather than inferred from the page body.
// These pages name individuals, so how long an intermediary is allowed to hold them is part of the ADR-0020
// surface, not an implementation detail: a wrong TTL keeps a corrected or withdrawn link on an edge cache
// after it has been pulled from the database.
import { describe, expect, it } from 'vitest';
import { headers as officialHeaders } from './conflict.official';
import { headers as companyHeaders } from './conflict.company';
import { headers as methodologyHeaders } from './conflict.methodology';
import { headers as leaderboardHeaders, meta as leaderboardMeta } from './conflicts';
import { meta as methodologyMeta } from './conflict.methodology';

const ONE_HOUR = /s-maxage=3600/;

describe('свързани-лица cache headers', () => {
  it('caches every conflict page publicly for an hour', () => {
    for (const h of [officialHeaders, companyHeaders, methodologyHeaders]) {
      const cc = h()['Cache-Control'];
      expect(cc).toMatch(ONE_HOUR);
      expect(cc).toMatch(/public/);
    }
  });

  it('the leaderboard honours a Cache-Control the loader set, and falls back when it set none', () => {
    // The loader may shorten the TTL (e.g. on a soft-failed read of an un-migrated env); the route must not
    // overwrite that with its own hour. With no loader header at all, the hour is the floor.
    expect(
      leaderboardHeaders({ loaderHeaders: new Headers({ 'Cache-Control': 'no-store' }) } as never)[
        'Cache-Control'
      ],
    ).toBe('no-store');
    expect(leaderboardHeaders({ loaderHeaders: new Headers() } as never)['Cache-Control']).toMatch(
      ONE_HOUR,
    );
  });
});

describe('indexing split between the naming pages and the methodology', () => {
  it('keeps the leaderboard out of search indexes', () => {
    const tags = leaderboardMeta({ matches: [], params: {} } as never);
    expect(tags).toContainEqual({ name: 'robots', content: 'noindex' });
  });

  it('leaves the methodology page indexable — it is the libel defence, not a naming page', () => {
    const tags = methodologyMeta({ matches: [], params: {} } as never);
    expect(tags.some((t) => t.name === 'robots' && t.content === 'noindex')).toBe(false);
    expect(tags.some((t) => t.title?.includes('методология'))).toBe(true);
  });
});
