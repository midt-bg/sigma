import { describe, expect, it } from 'vitest';
import { isFresh, KEEP_SECONDS, SAME_DATA_SECONDS, stamped, unstamp } from './edge-entry';

const NOW = Date.UTC(2026, 10, 19, 12);
const page = (policy: string) => new Response('page', { headers: { 'Cache-Control': policy } });
const at = (seconds: number) => NOW + seconds * 1000;

describe('a stored page and its notes', () => {
  it('is kept for its longest possible freshness plus the time it may stand in for a failed render', () => {
    const short = stamped(page('public, s-maxage=1800, stale-while-revalidate=86400'), NOW, null);
    expect(short.headers.get('Cache-Control')).toBe(
      `public, s-maxage=${SAME_DATA_SECONDS + KEEP_SECONDS}, stale-while-revalidate=86400`,
    );
    const long = stamped(page('public, s-maxage=43200'), NOW, null);
    expect(long.headers.get('Cache-Control')).toBe(`public, s-maxage=${43200 + KEEP_SECONDS}`);
  });

  it('gives the route its own policy back and keeps the notes to itself', () => {
    const policy = 'public, max-age=60, s-maxage=1800';
    const headers = new Headers(stamped(page(policy), NOW, 'g1').headers);
    unstamp(headers);
    expect(headers.get('Cache-Control')).toBe(policy);
    expect([...headers.keys()].filter((name) => name.startsWith('x-sigma-'))).toEqual([]);
  });

  it('restores the policy from the full copy when the headers at hand have lost the notes', () => {
    const full = stamped(page('public, s-maxage=1800'), NOW, 'g1').headers;
    const bare = new Headers({ 'Cache-Control': full.get('Cache-Control')! });
    unstamp(bare, full);
    expect(bare.get('Cache-Control')).toBe('public, s-maxage=1800');
  });

  it('leaves headers that carry no notes as they are', () => {
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    unstamp(headers);
    expect(headers.get('Cache-Control')).toBe('no-store');
  });

  it('never counts a page whose route asked for no edge freshness as fresh', () => {
    const none = stamped(new Response('page'), NOW, 'g1').headers;
    const browserOnly = stamped(page('public, max-age=60'), NOW, 'g1').headers;
    expect(isFresh(none, at(0), 'g1')).toBe(false);
    expect(isFresh(browserOnly, at(0), 'g1')).toBe(false);
    expect(browserOnly.get('Cache-Control')).toBe('public, max-age=60');
  });

  it('is fresh for as long as its route asked, whatever is known of the data', () => {
    const { headers } = stamped(page('public, s-maxage=1800'), NOW, null);
    expect(isFresh(headers, at(1799), null)).toBe(true);
    expect(isFresh(headers, at(1799), 'g2')).toBe(true);
    expect(isFresh(headers, at(1800), null)).toBe(false);
  });

  it('stays fresh past that only under the generation it was rendered from, and only up to the cap', () => {
    const { headers } = stamped(page('public, s-maxage=1800'), NOW, 'g1');
    expect(isFresh(headers, at(1800), 'g1')).toBe(true);
    expect(isFresh(headers, at(1800), 'g2')).toBe(false);
    expect(isFresh(headers, at(1800), null)).toBe(false);
    expect(isFresh(headers, at(SAME_DATA_SECONDS - 1), 'g1')).toBe(true);
    expect(isFresh(headers, at(SAME_DATA_SECONDS), 'g1')).toBe(false);
  });

  it('never calls fresh a copy it did not stamp', () => {
    expect(isFresh(new Headers({ 'Cache-Control': 'public, s-maxage=1800' }), NOW, 'g1')).toBe(
      false,
    );
  });
});
