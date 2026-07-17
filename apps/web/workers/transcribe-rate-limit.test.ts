import { describe, expect, it, vi } from 'vitest';
import { rateLimitTranscribeRoute } from './transcribe-rate-limit';

function rateLimiter(success: boolean): { limiter: RateLimit; limit: ReturnType<typeof vi.fn> } {
  const limit = vi.fn(async () => ({ success }));
  return { limiter: { limit } as RateLimit, limit };
}

const post = (ip = '203.0.113.50') =>
  new Request('http://local/assistant/transcribe', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip },
  });

describe('rateLimitTranscribeRoute', () => {
  it('limits POST /assistant/transcribe per IP', async () => {
    const { limiter, limit } = rateLimiter(false);
    const response = await rateLimitTranscribeRoute(
      post(),
      { TRANSCRIBE_RATE_LIMITER: limiter },
      false,
    );
    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.50' });
    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toBe('60');
  });

  it('still limits a doubled leading slash //assistant/transcribe (normalizedPathname collapse)', async () => {
    const { limiter, limit } = rateLimiter(false);
    const response = await rateLimitTranscribeRoute(
      new Request('http://local//assistant/transcribe', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '203.0.113.51' },
      }),
      { TRANSCRIBE_RATE_LIMITER: limiter },
      false,
    );
    expect(limit).toHaveBeenCalled();
    expect(response?.status).toBe(429);
  });

  it('lets a request through while under the limit', async () => {
    const { limiter } = rateLimiter(true);
    await expect(
      rateLimitTranscribeRoute(post(), { TRANSCRIBE_RATE_LIMITER: limiter }, false),
    ).resolves.toBeNull();
  });

  it.each(['PUT', 'PATCH', 'DELETE'])(
    'limits %s too — a RR resource route runs its action for it',
    async (method) => {
      const { limiter, limit } = rateLimiter(false);
      const response = await rateLimitTranscribeRoute(
        new Request('http://local/assistant/transcribe', {
          method,
          headers: { 'CF-Connecting-IP': '203.0.113.52' },
        }),
        { TRANSCRIBE_RATE_LIMITER: limiter },
        false,
      );
      expect(limit).toHaveBeenCalled();
      expect(response?.status).toBe(429);
    },
  );

  it('does not limit other methods or paths', async () => {
    const { limiter, limit } = rateLimiter(false);
    await expect(
      rateLimitTranscribeRoute(
        new Request('http://local/assistant/transcribe'),
        { TRANSCRIBE_RATE_LIMITER: limiter },
        false,
      ),
    ).resolves.toBeNull();
    await expect(
      rateLimitTranscribeRoute(
        new Request('http://local/assistant/chat', { method: 'POST' }),
        { TRANSCRIBE_RATE_LIMITER: limiter },
        false,
      ),
    ).resolves.toBeNull();
    expect(limit).not.toHaveBeenCalled();
  });

  it('fails open in non-prod when the binding is missing (dev/preview)', async () => {
    await expect(rateLimitTranscribeRoute(post(), {}, false)).resolves.toBeNull();
  });

  it('fails CLOSED with a 503 in production when the binding is missing', async () => {
    const response = await rateLimitTranscribeRoute(post(), {}, true);
    expect(response?.status).toBe(503);
    expect(response?.headers.get('Retry-After')).toBe('60');
  });

  it('fails CLOSED with a 503 in production when the limiter throws', async () => {
    const limiter = {
      limit: vi.fn(async () => {
        throw new Error('limiter down');
      }),
    } as unknown as RateLimit;
    const response = await rateLimitTranscribeRoute(
      post(),
      { TRANSCRIBE_RATE_LIMITER: limiter },
      true,
    );
    expect(response?.status).toBe(503);
  });
});
