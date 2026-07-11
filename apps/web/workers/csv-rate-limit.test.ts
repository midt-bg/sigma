import { describe, expect, it, vi } from 'vitest';
import { rateLimitCsvExport } from './csv-rate-limit';

function rateLimiter(success: boolean): { limiter: RateLimit; limit: ReturnType<typeof vi.fn> } {
  const limit = vi.fn(async () => ({ success }));
  return { limiter: { limit } as RateLimit, limit };
}

describe('rateLimitCsvExport', () => {
  it('allows CSV requests when the limiter allows the key', async () => {
    const { limiter, limit } = rateLimiter(true);

    const response = await rateLimitCsvExport(
      new Request('http://local/contracts.csv', {
        headers: { 'CF-Connecting-IP': '203.0.113.10' },
      }),
      { CSV_RATE_LIMITER: limiter },
      false,
    );

    expect(response).toBeNull();
    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.10' });
  });

  it('matches CSV requests after path decoding and lowercasing', async () => {
    const { limiter, limit } = rateLimiter(true);

    for (const path of ['/contracts.CSV', '/contracts%2Ecsv', '/contracts%2ECSV']) {
      await expect(
        rateLimitCsvExport(
          new Request(`http://local${path}`, {
            headers: { 'CF-Connecting-IP': '203.0.113.20' },
          }),
          { CSV_RATE_LIMITER: limiter },
          false,
        ),
      ).resolves.toBeNull();
    }

    expect(limit).toHaveBeenCalledTimes(3);
    expect(limit).toHaveBeenNthCalledWith(1, { key: '203.0.113.20' });
    expect(limit).toHaveBeenNthCalledWith(2, { key: '203.0.113.20' });
    expect(limit).toHaveBeenNthCalledWith(3, { key: '203.0.113.20' });
  });

  it('matches CSV requests with trailing slashes through shared path normalization', async () => {
    const { limiter, limit } = rateLimiter(true);

    await expect(
      rateLimitCsvExport(
        new Request('http://local/contracts.csv///', {
          headers: { 'CF-Connecting-IP': '203.0.113.21' },
        }),
        { CSV_RATE_LIMITER: limiter },
        false,
      ),
    ).resolves.toBeNull();

    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.21' });
  });

  it('limits the single-fetch /contracts.csv.data twin the same as /contracts.csv (#184)', async () => {
    const { limiter, limit } = rateLimiter(false);

    const response = await rateLimitCsvExport(
      new Request('http://local/contracts.csv.data', {
        headers: { 'CF-Connecting-IP': '203.0.113.22' },
      }),
      { CSV_RATE_LIMITER: limiter },
      false,
    );

    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.22' });
    expect(response?.status).toBe(429);
  });

  it('returns a hardened 429 when the limiter rejects the key', async () => {
    const { limiter, limit } = rateLimiter(false);

    const response = await rateLimitCsvExport(
      new Request('http://local/contracts.csv', {
        headers: { 'CF-Connecting-IP': '198.51.100.9' },
      }),
      { CSV_RATE_LIMITER: limiter },
      true,
    );

    expect(limit).toHaveBeenCalledWith({ key: '198.51.100.9' });
    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toBe('60');
    expect(response?.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response?.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
  });

  it('uses the shared fallback key without trusting X-Forwarded-For', async () => {
    const { limiter, limit } = rateLimiter(true);

    await rateLimitCsvExport(
      new Request('http://local/contracts.csv', {
        headers: { 'X-Forwarded-For': '198.51.100.99, 10.0.0.1' },
      }),
      { CSV_RATE_LIMITER: limiter },
      false,
    );

    expect(limit).toHaveBeenCalledWith({ key: 'unknown-client' });
  });

  it('fails open when the binding is missing', async () => {
    await expect(
      rateLimitCsvExport(new Request('http://local/contracts.csv'), {}, false),
    ).resolves.toBeNull();
  });

  it('fails open when the binding throws', async () => {
    const limit = vi.fn(async () => {
      throw new Error('rate limit unavailable');
    });

    await expect(
      rateLimitCsvExport(
        new Request('http://local/contracts.csv'),
        { CSV_RATE_LIMITER: { limit } as RateLimit },
        false,
      ),
    ).resolves.toBeNull();
  });

  it('does not call the limiter for non-CSV requests', async () => {
    const { limiter, limit } = rateLimiter(false);

    const response = await rateLimitCsvExport(
      new Request('http://local/'),
      { CSV_RATE_LIMITER: limiter },
      false,
    );

    expect(response).toBeNull();
    expect(limit).not.toHaveBeenCalled();
  });
});
