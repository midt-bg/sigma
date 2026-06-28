import { describe, expect, it, vi } from 'vitest';
import { rateLimitAssistantRoute } from './assistant-rate-limit';

function rateLimiter(success: boolean): { limiter: RateLimit; limit: ReturnType<typeof vi.fn> } {
  const limit = vi.fn(async () => ({ success }));
  return { limiter: { limit } as RateLimit, limit };
}

const post = (ip = '203.0.113.40') =>
  new Request('http://local/assistant/chat', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip },
  });

describe('rateLimitAssistantRoute', () => {
  it('limits POST /assistant/chat per IP', async () => {
    const { limiter, limit } = rateLimiter(false);
    const response = await rateLimitAssistantRoute(
      post(),
      { ASSISTANT_RATE_LIMITER: limiter },
      false,
    );
    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.40' });
    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toBe('60');
  });

  it('still limits a doubled leading slash //assistant/chat (review #80, ydimitrof)', async () => {
    // normalizedPathname collapses `//` so the path-equality match — and the limiter — still fire.
    const { limiter, limit } = rateLimiter(false);
    const response = await rateLimitAssistantRoute(
      new Request('http://local//assistant/chat', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '203.0.113.41' },
      }),
      { ASSISTANT_RATE_LIMITER: limiter },
      false,
    );
    expect(limit).toHaveBeenCalled();
    expect(response?.status).toBe(429);
  });

  it('lets a request through while under the limit', async () => {
    const { limiter } = rateLimiter(true);
    await expect(
      rateLimitAssistantRoute(post(), { ASSISTANT_RATE_LIMITER: limiter }, false),
    ).resolves.toBeNull();
  });

  it('limits PUT/PATCH/DELETE too — a RR resource route runs its action for them (review #80, follow-up)', async () => {
    // assistant.chat exports only `action`, which React Router dispatches for EVERY mutation method, so
    // gating the limiter on `method === 'POST'` let PUT/PATCH/DELETE reach the paid loop unthrottled.
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const { limiter, limit } = rateLimiter(false);
      const response = await rateLimitAssistantRoute(
        new Request('http://local/assistant/chat', {
          method,
          headers: { 'CF-Connecting-IP': '203.0.113.42' },
        }),
        { ASSISTANT_RATE_LIMITER: limiter },
        false,
      );
      expect(limit, method).toHaveBeenCalled();
      expect(response?.status, method).toBe(429);
    }
  });

  it('does not limit other methods or paths', async () => {
    const { limiter, limit } = rateLimiter(false);
    // GET on the same path
    await expect(
      rateLimitAssistantRoute(
        new Request('http://local/assistant/chat'),
        { ASSISTANT_RATE_LIMITER: limiter },
        false,
      ),
    ).resolves.toBeNull();
    // POST on a different path
    await expect(
      rateLimitAssistantRoute(
        new Request('http://local/contracts', { method: 'POST' }),
        { ASSISTANT_RATE_LIMITER: limiter },
        false,
      ),
    ).resolves.toBeNull();
    expect(limit).not.toHaveBeenCalled();
  });

  it('fails open in non-prod when the binding is missing (dev/preview)', async () => {
    await expect(rateLimitAssistantRoute(post(), {}, false)).resolves.toBeNull();
  });

  it('fails CLOSED with a 503 in production when the binding is missing (review #80)', async () => {
    const response = await rateLimitAssistantRoute(post(), {}, true);
    expect(response?.status).toBe(503);
    expect(response?.headers.get('Retry-After')).toBe('60');
  });

  it('fails CLOSED with a 503 in production when the limiter throws', async () => {
    const limiter = {
      limit: vi.fn(async () => {
        throw new Error('limiter down');
      }),
    } as unknown as RateLimit;
    const response = await rateLimitAssistantRoute(
      post(),
      { ASSISTANT_RATE_LIMITER: limiter },
      true,
    );
    expect(response?.status).toBe(503);
  });
});
