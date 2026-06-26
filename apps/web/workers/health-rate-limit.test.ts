import { describe, expect, it, vi } from 'vitest';
import { rateLimitHealthRoute } from './health-rate-limit';

function rateLimiter(success: boolean): { limiter: RateLimit; limit: ReturnType<typeof vi.fn> } {
  const limit = vi.fn(async () => ({ success }));
  return { limiter: { limit } as RateLimit, limit };
}

describe('rateLimitHealthRoute', () => {
  it('limits /health requests keyed on client IP', async () => {
    const { limiter, limit } = rateLimiter(false);

    const response = await rateLimitHealthRoute(
      new Request('http://local/health', {
        headers: { 'CF-Connecting-IP': '203.0.113.50' },
      }),
      { HEALTH_RATE_LIMITER: limiter },
      false,
    );

    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.50' });
    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toBe('60');
  });

  it('limits /health with a trailing slash', async () => {
    const { limiter, limit } = rateLimiter(false);

    const response = await rateLimitHealthRoute(
      new Request('http://local/health/', {
        headers: { 'CF-Connecting-IP': '203.0.113.51' },
      }),
      { HEALTH_RATE_LIMITER: limiter },
      false,
    );

    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.51' });
    expect(response?.status).toBe(429);
  });

  it('does not limit unrelated paths', async () => {
    const { limiter, limit } = rateLimiter(false);

    await expect(
      rateLimitHealthRoute(
        new Request('http://local/contracts'),
        { HEALTH_RATE_LIMITER: limiter },
        false,
      ),
    ).resolves.toBeNull();
    expect(limit).not.toHaveBeenCalled();
  });

  it('fails open when the binding is missing or throws', async () => {
    await expect(
      rateLimitHealthRoute(new Request('http://local/health'), {}, false),
    ).resolves.toBeNull();

    const limit = vi.fn(async () => {
      throw new Error('rate limit unavailable');
    });
    await expect(
      rateLimitHealthRoute(
        new Request('http://local/health'),
        { HEALTH_RATE_LIMITER: { limit } as RateLimit },
        false,
      ),
    ).resolves.toBeNull();
  });
});
