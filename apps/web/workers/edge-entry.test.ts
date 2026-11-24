import { describe, expect, it } from 'vitest';
import { edgeTtl, entryId, isFresh, stamped, unstamp } from './edge-entry';

const began = Date.UTC(2000, 0, 1);
const page = (policy: string) => new Response('page', { headers: { 'Cache-Control': policy } });

describe('edge entry', () => {
  it('retains the route TTL, with no stale directives, and ages from the start of the render', () => {
    const { headers } = stamped(
      page('public, s-maxage=120, stale-while-revalidate=86400, stale-if-error=60'),
      began + 120_000,
    );
    expect(headers.get('Cache-Control')).toBe('public, s-maxage=120');
    expect(isFresh(headers, began + 119_999)).toBe(true);
    expect(isFresh(headers, began + 120_000)).toBe(false);
  });

  it('gives two copies unique identities even when their freshness limits match', () => {
    const expiry = began + 120_000;
    const first = stamped(page('public, s-maxage=120'), expiry).headers;
    const second = stamped(page('public, s-maxage=120'), expiry).headers;
    expect(entryId(first)).not.toBe(entryId(second));
    unstamp(first);
    expect(entryId(first)).toBeNull();
    expect(isFresh(first, began)).toBe(false);
  });

  it.each(['private, s-maxage=120', 'NO-STORE, s-maxage=120', 's-maxage=0', 'max-age=120'])(
    'declines edge storage for %s',
    (policy) => expect(edgeTtl(page(policy).headers)).toBe(0),
  );
});
