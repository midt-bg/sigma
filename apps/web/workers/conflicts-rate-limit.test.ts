import { describe, expect, it, vi } from 'vitest';
import { rateLimitConflictsRoute } from './conflicts-rate-limit';

function rateLimiter(success: boolean): { limiter: RateLimit; limit: ReturnType<typeof vi.fn> } {
  const limit = vi.fn(async () => ({ success }));
  return { limiter: { limit } as RateLimit, limit };
}

describe('rateLimitConflictsRoute', () => {
  it('limits the whole /conflicts subtree (leaderboard + per-official + per-company)', async () => {
    for (const path of [
      '/conflicts',
      '/conflicts/',
      '/conflicts/official/ivan-petrov',
      '/conflicts/company/123456789',
      '/conflicts/methodology',
    ]) {
      const { limiter, limit } = rateLimiter(false);
      const response = await rateLimitConflictsRoute(
        new Request(`http://local${path}`, { headers: { 'CF-Connecting-IP': '203.0.113.40' } }),
        { CONFLICTS_RATE_LIMITER: limiter },
        false,
      );
      expect(limit, path).toHaveBeenCalledWith({ key: '203.0.113.40' });
      expect(response?.status, path).toBe(429);
      expect(response?.headers.get('Retry-After'), path).toBe('60');
    }
  });

  it('limits the single-fetch .data twins the same as the bare paths (the scrape vector)', async () => {
    for (const path of ['/conflicts.data', '/conflicts/official/ivan-petrov.data']) {
      const { limiter } = rateLimiter(false);
      const response = await rateLimitConflictsRoute(
        new Request(`http://local${path}`, { headers: { 'CF-Connecting-IP': '203.0.113.41' } }),
        { CONFLICTS_RATE_LIMITER: limiter },
        false,
      );
      expect(response?.status, path).toBe(429);
    }
  });

  it('does not match a sibling path that merely starts with the same prefix', async () => {
    const { limiter, limit } = rateLimiter(false);
    await expect(
      rateLimitConflictsRoute(
        new Request('http://local/conflicts-guide'),
        { CONFLICTS_RATE_LIMITER: limiter },
        false,
      ),
    ).resolves.toBeNull();
    expect(limit).not.toHaveBeenCalled();
  });

  it('does not limit unrelated paths', async () => {
    const { limiter, limit } = rateLimiter(false);
    await expect(
      rateLimitConflictsRoute(
        new Request('http://local/companies'),
        { CONFLICTS_RATE_LIMITER: limiter },
        false,
      ),
    ).resolves.toBeNull();
    expect(limit).not.toHaveBeenCalled();
  });

  // Non-prod (dev/preview, binding routinely absent) degrades to a no-op so local work isn't blocked —
  // failClosed only engages in prod.
  it('fails OPEN in non-prod when the binding is missing or throws', async () => {
    await expect(
      rateLimitConflictsRoute(new Request('http://local/conflicts'), {}, false),
    ).resolves.toBeNull();

    const limit = vi.fn(async () => {
      throw new Error('rate limit unavailable');
    });
    await expect(
      rateLimitConflictsRoute(
        new Request('http://local/conflicts'),
        { CONFLICTS_RATE_LIMITER: { limit } as RateLimit },
        false,
      ),
    ).resolves.toBeNull();
  });

  // In prod the names surface fails CLOSED: a missing/erroring binding must 503, never serve the .data
  // twins unthrottled (the sole anti-enumeration control on a names DB).
  it('fails CLOSED with 503 in prod when the binding is missing', async () => {
    const response = await rateLimitConflictsRoute(
      new Request('http://local/conflicts/official/ivan-petrov.data'),
      {},
      true,
    );
    expect(response?.status).toBe(503);
    expect(response?.headers.get('Retry-After')).toBe('60');
  });

  it('fails CLOSED with 503 in prod when the limiter throws', async () => {
    const limit = vi.fn(async () => {
      throw new Error('rate limit unavailable');
    });
    const response = await rateLimitConflictsRoute(
      new Request('http://local/conflicts'),
      { CONFLICTS_RATE_LIMITER: { limit } as RateLimit },
      true,
    );
    expect(response?.status).toBe(503);
  });
});
