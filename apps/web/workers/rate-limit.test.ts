import { describe, expect, it, vi } from 'vitest';
import { rateLimitKey, rateLimitRequest } from './rate-limit';

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

describe('rateLimitKey', () => {
  it('keys on CF-Connecting-IP and falls back when absent', () => {
    expect(rateLimitKey(req('198.51.100.9'))).toBe('198.51.100.9');
    expect(rateLimitKey(new Request('http://local/x'))).toBe('unknown-client');
  });
});
