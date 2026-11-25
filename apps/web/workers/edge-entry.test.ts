import { describe, expect, it } from 'vitest';
import {
  DEGRADED_TTL_SECONDS,
  degraded,
  edgeTtl,
  entryId,
  isFresh,
  MAX_SERVING_MS,
  stamped,
  unstamp,
} from './edge-entry';

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

  it('caps serving time independently of the storage policy', () => {
    const policy = 'public, s-maxage=86400';
    const response = page(policy);
    expect(edgeTtl(response.headers) * 1000).toBe(MAX_SERVING_MS);
    expect(stamped(response, began + MAX_SERVING_MS).headers.get('Cache-Control')).toBe(policy);
  });

  it.each(['private, s-maxage=120', 'NO-STORE, s-maxage=120', 's-maxage=0', 'max-age=120'])(
    'declines edge storage for %s',
    (policy) => expect(edgeTtl(page(policy).headers)).toBe(0),
  );

  it('keeps a degraded page at the edge no longer than a 503 asks a client to wait', async () => {
    const response = degraded(
      page('public, s-maxage=3600, stale-while-revalidate=86400'),
      'footer',
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('page');
    expect(response.headers.get('Cache-Control')).toBe(`public, s-maxage=${DEGRADED_TTL_SECONDS}`);
    expect(response.headers.get('X-Sigma-Degraded')).toBe('footer');
  });

  it('never lengthens a route policy that is already shorter', () => {
    const { headers } = degraded(page('public, s-maxage=10'), 'footer');
    expect(headers.get('Cache-Control')).toBe('public, s-maxage=10');
  });

  it.each(['no-store', 'private, s-maxage=120', 'max-age=120'])(
    'leaves a policy the edge would not keep (%s) as the route set it',
    (policy) => {
      const { headers } = degraded(page(policy), 'footer');
      expect(headers.get('Cache-Control')).toBe(policy);
      expect(headers.get('X-Sigma-Degraded')).toBe('footer');
    },
  );

  it.each([404, 500, 503])('passes a %i through untouched', (status) => {
    const failed = new Response('x', { status, headers: { 'Cache-Control': 'no-store' } });
    expect(degraded(failed, 'footer')).toBe(failed);
  });
});
