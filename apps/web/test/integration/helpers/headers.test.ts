import { describe, expect, it } from 'vitest';
import { assertCacheable } from './headers';

describe('assertCacheable — s-maxage must be non-zero (ydimitrof review 2026-08-31, thread on headers.ts:179)', () => {
  it('accepts a positive s-maxage with stale-while-revalidate', () => {
    const res = new Response('body', {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400' },
    });
    expect(() => assertCacheable(res)).not.toThrow();
  });

  it('rejects `s-maxage=0` (not edge-cacheable — "do not cache")', () => {
    // The previous regex `/s-maxage=\d+/` matched `s-maxage=0`, and the bare
    // `stale-while-revalidate=` check did not exclude the zero case, so a response with
    // `public, s-maxage=0, stale-while-revalidate=60` would have passed the assertion even
    // though it is NOT edge-cacheable. The fix tightens the regex to `[1-9]\d*` so `s-maxage=0`
    // fails — this is the regression the new test pins.
    const res = new Response('body', {
      headers: { 'Cache-Control': 'public, s-maxage=0, stale-while-revalidate=60' },
    });
    expect(() => assertCacheable(res)).toThrow(/s-maxage/);
  });

  it('rejects when s-maxage is missing entirely', () => {
    const res = new Response('body', {
      headers: { 'Cache-Control': 'public, stale-while-revalidate=60' },
    });
    expect(() => assertCacheable(res)).toThrow(/s-maxage/);
  });

  it('rejects when stale-while-revalidate is missing (both directives must appear together)', () => {
    const res = new Response('body', { headers: { 'Cache-Control': 'public, s-maxage=3600' } });
    expect(() => assertCacheable(res)).toThrow(/stale-while-revalidate/);
  });

  // PR #177 review (ydimitrof 2026-09-03, thread on headers.ts:200): the regex is anchored to
  // a directive boundary (`(?:^|[\s,])`) so a hypothetical `x-s-maxage=5` header — or any
  // non-Cache-Control header that happens to contain the literal `s-maxage=` substring — cannot
  // false-positive. The new test pins the boundary: a Cache-Control value that mentions the
  // substring as a non-directive substring fails.
  it('rejects s-maxage occurring as a non-directive substring (e.g. inside a header NAME)', () => {
    // A "Cache-Control" header that contains the literal text `s-maxage=5` as part of a
    // hypothetical `x-foo-s-maxage=5` directive would slip past the old unanchored regex. With
    // the `(?:^|[\s,])` boundary the substring must start a directive, otherwise the regex misses.
    // (Real `Cache-Control` headers do not have such neighbour-directives; the assertion is a
    // belt-and-braces against a future custom directive name that happens to contain the text.)
    const res = new Response('body', {
      headers: { 'Cache-Control': 'public, x-foo-s-maxage=5, stale-while-revalidate=60' },
    });
    expect(() => assertCacheable(res)).toThrow(/s-maxage/);
  });
});
