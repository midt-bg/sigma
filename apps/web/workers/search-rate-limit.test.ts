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

  it('limits search sub-paths such as /search/suggest', async () => {
    const { limiter } = rateLimiter(false);

    const response = await rateLimitSearchRoute(
      new Request('http://local/search/suggest?q=стр', {
        headers: { 'CF-Connecting-IP': '203.0.113.42' },
      }),
      { SEARCH_RATE_LIMITER: limiter },
      false,
    );

    expect(response?.status).toBe(429);
  });

  it('limits the single-fetch /search.data twin the same as /search (#184)', async () => {
    const { limiter } = rateLimiter(false);

    for (const path of ['/search.data?q=a', '/search/suggest.data?q=a']) {
      const response = await rateLimitSearchRoute(
        new Request(`http://local${path}`, { headers: { 'CF-Connecting-IP': '203.0.113.43' } }),
        { SEARCH_RATE_LIMITER: limiter },
        false,
      );
      expect(response?.status, path).toBe(429);
    }
  });

  it('does not limit unrelated paths', async () => {
    const { limiter, limit } = rateLimiter(false);

    for (const path of ['/contracts', '/searchx', '/search-history']) {
      await expect(
        rateLimitSearchRoute(
          new Request(`http://local${path}`),
          { SEARCH_RATE_LIMITER: limiter },
          false,
        ),
      ).resolves.toBeNull();
    }
    expect(limit).not.toHaveBeenCalled();
  });

  it('fails open and logs a degrade event when the binding is missing or throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

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

    const events = warn.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'rate_limit_missing_binding',
        limiter: 'SEARCH_RATE_LIMITER',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'rate_limit_limiter_error',
        limiter: 'SEARCH_RATE_LIMITER',
      }),
    );

    warn.mockRestore();
  });
});
