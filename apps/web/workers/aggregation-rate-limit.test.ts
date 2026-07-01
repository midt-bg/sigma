import { describe, expect, it, vi } from 'vitest';
import { rateLimitAggregationRoute } from './aggregation-rate-limit';
import { normalizedPathname } from './rate-limit';

function rateLimiter(success: boolean): { limiter: RateLimit; limit: ReturnType<typeof vi.fn> } {
  const limit = vi.fn(async () => ({ success }));
  return { limiter: { limit } as RateLimit, limit };
}

describe('rateLimitAggregationRoute', () => {
  it('limits aggregation listing requests', async () => {
    const { limiter, limit } = rateLimiter(false);

    const response = await rateLimitAggregationRoute(
      new Request('http://local/companies', {
        headers: { 'CF-Connecting-IP': '203.0.113.30' },
      }),
      { AGG_RATE_LIMITER: limiter },
      false,
    );

    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.30' });
    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toBe('60');
  });

  it('limits aggregation listing requests with a trailing slash', async () => {
    const { limiter, limit } = rateLimiter(false);

    const response = await rateLimitAggregationRoute(
      new Request('http://local/companies/', {
        headers: { 'CF-Connecting-IP': '203.0.113.31' },
      }),
      { AGG_RATE_LIMITER: limiter },
      false,
    );

    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.31' });
    expect(response?.status).toBe(429);
  });

  it('normalizes trailing slashes while preserving root', () => {
    expect(normalizedPathname(new Request('http://local/'))).toBe('/');
    expect(normalizedPathname(new Request('http://local/companies/'))).toBe('/companies');
    expect(normalizedPathname(new Request('http://local/companies///'))).toBe('/companies');
  });

  it('limits the single-fetch .data twins the same as the bare paths (#184)', async () => {
    for (const path of ['/companies.data', '/authorities.data']) {
      const { limiter } = rateLimiter(false);
      const response = await rateLimitAggregationRoute(
        new Request(`http://local${path}`, { headers: { 'CF-Connecting-IP': '203.0.113.32' } }),
        { AGG_RATE_LIMITER: limiter },
        false,
      );
      expect(response?.status, path).toBe(429);
    }
  });

  it('does not limit unrelated paths', async () => {
    const { limiter, limit } = rateLimiter(false);

    await expect(
      rateLimitAggregationRoute(
        new Request('http://local/contracts'),
        { AGG_RATE_LIMITER: limiter },
        false,
      ),
    ).resolves.toBeNull();
    expect(limit).not.toHaveBeenCalled();
  });

  it('fails open when the binding is missing or throws', async () => {
    await expect(
      rateLimitAggregationRoute(new Request('http://local/authorities'), {}, false),
    ).resolves.toBeNull();

    const limit = vi.fn(async () => {
      throw new Error('rate limit unavailable');
    });
    await expect(
      rateLimitAggregationRoute(
        new Request('http://local/authorities'),
        { AGG_RATE_LIMITER: { limit } as RateLimit },
        false,
      ),
    ).resolves.toBeNull();
  });
});
