import { describe, it, expect } from 'vitest';
import { rateLimitBgGptGlobal } from './bggpt-global-rate-limit';
import type { BgGptCircuitBreaker } from './assistant/bggpt-circuit-breaker';
import type { RpmDecision } from './assistant/rpm-window';

const POST = new Request('https://sigma.example/assistant/chat', { method: 'POST' });

/** Minimal DO-namespace fake: one instance whose `admit()` returns `decision` (or throws). */
function breakerNs(decision: RpmDecision | 'throw'): DurableObjectNamespace<BgGptCircuitBreaker> {
  const stub = {
    admit: async () => {
      if (decision === 'throw') throw new Error('DO unavailable');
      return decision;
    },
  };
  return {
    idFromName: () => ({}) as DurableObjectId,
    get: () => stub as unknown as DurableObjectStub<BgGptCircuitBreaker>,
  } as unknown as DurableObjectNamespace<BgGptCircuitBreaker>;
}

const allow: RpmDecision = { allowed: true, used: 1, limit: 120, retryAfterMs: 0 };
const deny: RpmDecision = { allowed: false, used: 120, limit: 120, retryAfterMs: 42_000 };

describe('rateLimitBgGptGlobal', () => {
  it('proceeds (null) when the breaker admits the call', async () => {
    expect(await rateLimitBgGptGlobal(POST, breakerNs(allow), true)).toBeNull();
  });

  it('returns 429 with the Bulgarian overload message when the breaker is open', async () => {
    const res = await rateLimitBgGptGlobal(POST, breakerNs(deny), true);
    expect(res?.status).toBe(429);
    expect(res?.headers.get('Retry-After')).toBe('60');
    await expect(res?.text()).resolves.toContain('претоварен');
  });

  it('fails CLOSED (503) in production when the binding is missing', async () => {
    const res = await rateLimitBgGptGlobal(POST, undefined, true);
    expect(res?.status).toBe(503);
  });

  it('degrades to a no-op (null) in dev when the binding is missing', async () => {
    expect(await rateLimitBgGptGlobal(POST, undefined, false)).toBeNull();
  });

  it('fails CLOSED (503) in production when the breaker errors', async () => {
    const res = await rateLimitBgGptGlobal(POST, breakerNs('throw'), true);
    expect(res?.status).toBe(503);
  });

  it('degrades to a no-op (null) in dev when the breaker errors', async () => {
    expect(await rateLimitBgGptGlobal(POST, breakerNs('throw'), false)).toBeNull();
  });
});
