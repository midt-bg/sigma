import { describe, expect, it, vi } from 'vitest';
import { rateLimitSearchRoute } from './search-rate-limit';

function rateLimiter(success: boolean): { limiter: RateLimit; limit: ReturnType<typeof vi.fn> } {
  const limit = vi.fn(async () => ({ success }));
  return { limiter: { limit } as RateLimit, limit };
}

describe('rateLimitSearchRoute', () => {
  it('limits search requests keyed on client IP', async () => {
    const { limiter, limit } = rateLimiter(false);

    const response = await rateLimitSearchRoute(
      new Request('http://local/search?q=строителство', {
        headers: { 'CF-Connecting-IP': '203.0.113.40' },
      }),
      { SEARCH_RATE_LIMITER: limiter },
      false,
    );

    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.40' });
    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toBe('60');
  });

  it('limits search requests with a trailing slash', async () => {
    const { limiter } = rateLimiter(false);

    const response = await rateLimitSearchRoute(
      new Request('http://local/search/?q=a', { headers: { 'CF-Connecting-IP': '203.0.113.41' } }),
      { SEARCH_RATE_LIMITER: limiter },
      false,
    );

    expect(response?.status).toBe(429);
  });

  it('does not limit unrelated paths', async () => {
    const { limiter, limit } = rateLimiter(false);

    await expect(
      rateLimitSearchRoute(
        new Request('http://local/contracts'),
        { SEARCH_RATE_LIMITER: limiter },
        false,
      ),
    ).resolves.toBeNull();
    expect(limit).not.toHaveBeenCalled();
  });

  it('fails open when the binding is missing or throws', async () => {
    await expect(
      rateLimitSearchRoute(new Request('http://local/search?q=a'), {}, false),
    ).resolves.toBeNull();

    const limit = vi.fn(async () => {
      throw new Error('rate limit unavailable');
    });
    await expect(
      rateLimitSearchRoute(
        new Request('http://local/search?q=a'),
        { SEARCH_RATE_LIMITER: { limit } as RateLimit },
        false,
      ),
    ).resolves.toBeNull();
  });
});
