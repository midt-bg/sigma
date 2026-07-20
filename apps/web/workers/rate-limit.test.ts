import { describe, expect, it, vi } from 'vitest';
import {
  normalizedPathname,
  rateLimitExceededResponse,
  rateLimitKey,
  rateLimitRequest,
  rateLimitUnavailableResponse,
} from './rate-limit';

const req = (ip = '203.0.113.7') =>
  new Request('http://local/x', { method: 'POST', headers: { 'CF-Connecting-IP': ip } });
const limiter = (success: boolean): RateLimit =>
  ({ limit: vi.fn(async () => ({ success })) }) as RateLimit;
const throwing = (): RateLimit =>
  ({
    limit: vi.fn(async () => {
      throw new Error('limiter down');
    }),
  }) as unknown as RateLimit;

describe('rateLimitRequest', () => {
  it('returns null when under the limit', async () => {
    await expect(rateLimitRequest(req(), limiter(true), true, 'body', 'L')).resolves.toBeNull();
  });

  it('returns 429 when over the limit', async () => {
    const r = await rateLimitRequest(req(), limiter(false), true, 'body', 'L');
    expect(r?.status).toBe(429);
  });

  // Default (CSV/aggregation/search) — fail OPEN on a missing binding or a limiter error.
  it('fails OPEN by default when the binding is missing', async () => {
    await expect(rateLimitRequest(req(), undefined, true, 'body', 'L')).resolves.toBeNull();
  });
  it('fails OPEN by default when the limiter throws', async () => {
    await expect(rateLimitRequest(req(), throwing(), true, 'body', 'L')).resolves.toBeNull();
  });

  // failClosed (the assistant) — reject with 503 in PRODUCTION when the limiter is unusable.
  it('fails CLOSED with 503 in prod on a missing binding when failClosed', async () => {
    const r = await rateLimitRequest(req(), undefined, true, 'body', 'L', { failClosed: true });
    expect(r?.status).toBe(503);
  });
  it('fails CLOSED with 503 in prod when the limiter throws and failClosed', async () => {
    const r = await rateLimitRequest(req(), throwing(), true, 'body', 'L', { failClosed: true });
    expect(r?.status).toBe(503);
  });
  // …but NOT in dev/preview, where the binding is routinely absent.
  it('still fails OPEN in non-prod even when failClosed', async () => {
    await expect(
      rateLimitRequest(req(), undefined, false, 'body', 'L', { failClosed: true }),
    ).resolves.toBeNull();
  });
});

describe('normalizedPathname', () => {
  const path = (p: string) => normalizedPathname(new Request(`http://local${p}`));

  // RRv7 single-fetch serves loaders at `<path>.data`; the limiters must classify by the canonical
  // route path RR resolves, else every limiter is bypassable via the suffix (#184).
  it('strips a trailing .data suffix', () => {
    expect(path('/search.data')).toBe('/search');
    expect(path('/companies.data')).toBe('/companies');
    expect(path('/contracts.csv.data')).toBe('/contracts.csv');
    expect(path('/assistant/chat.data')).toBe('/assistant/chat');
  });

  it('strips .data before the trailing-slash strip and preserves other normalization', () => {
    expect(path('/SEARCH.data')).toBe('/search');
    expect(path('//companies.data')).toBe('/companies');
  });

  it('only strips a trailing .data, not a mid-path .data segment', () => {
    expect(path('/foo.data/bar')).toBe('/foo.data/bar');
    expect(path('/search.database')).toBe('/search.database');
  });

  // Mirror RR's single strip: `/\.data$/` removes exactly one trailing suffix, and a trailing slash
  // defeats `.data` detection (RRv7 getNormalizedPath strips `.data$` before the slash, so `.data/`
  // is not a data request and 404s — the limiter classifying it as a miss matches RR, not a bypass).
  it('strips only one trailing .data and does not treat .data/ as a data request', () => {
    expect(path('/search.data.data')).toBe('/search.data');
    expect(path('/search.data/')).toBe('/search.data');
  });

  it('maps /_root.data to /_root (harmless — no limiter targets the root loader)', () => {
    expect(path('/_root.data')).toBe('/_root');
  });

  it('also strips .data in the decode-failure (catch) branch', () => {
    // `%zz` is invalid percent-encoding, so decodeURIComponent throws and the catch branch runs;
    // it must still strip the trailing .data off the raw (lowercased) pathname.
    expect(path('/search%zz.data')).toBe('/search%zz');
  });
});

// The two response builders special-case HEAD (a HEAD response must carry no body and no
// Content-Type, per HTTP semantics) and both stamp Retry-After + the shared security headers.
// Cover both the GET/POST body path AND the HEAD no-body path so the method branch is exercised.
describe('rateLimitExceededResponse', () => {
  it('returns a 429 with the body and hardened headers for a non-HEAD request', async () => {
    const res = rateLimitExceededResponse(req(), true, 'Too many requests');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await res.text()).toBe('Too many requests');
  });

  it('omits the body and Content-Type for a HEAD request but keeps status + headers', async () => {
    const head = new Request('http://local/x', { method: 'HEAD' });
    const res = rateLimitExceededResponse(head, true, 'Too many requests');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(res.headers.get('Content-Type')).toBeNull();
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await res.text()).toBe('');
  });
});

describe('rateLimitUnavailableResponse', () => {
  it('returns a 503 with a body and hardened headers for a non-HEAD request', async () => {
    const res = rateLimitUnavailableResponse(req(), true);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await res.text()).toBe('Rate limiting unavailable');
  });

  it('omits the body and Content-Type for a HEAD request but keeps status + headers', async () => {
    const head = new Request('http://local/x', { method: 'HEAD' });
    const res = rateLimitUnavailableResponse(head, true);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(res.headers.get('Content-Type')).toBeNull();
    expect(await res.text()).toBe('');
  });
});

describe('rateLimitKey', () => {
  it('keys on CF-Connecting-IP and falls back when absent', () => {
    expect(rateLimitKey(req('198.51.100.9'))).toBe('198.51.100.9');
    expect(rateLimitKey(new Request('http://local/x'))).toBe('unknown-client');
  });
});
