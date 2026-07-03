import { afterEach, describe, expect, it, vi } from 'vitest';
import { TURNSTILE_TOKEN_HEADER, turnstileRejection, verifyTurnstileToken } from './turnstile';

function mockFetch(impl: () => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}
function siteverify(success: boolean): Response {
  return new Response(JSON.stringify({ success }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
function req(headers: Record<string, string> = {}): Request {
  return new Request('https://sigma.example/assistant/chat', { method: 'POST', headers });
}

afterEach(() => vi.unstubAllGlobals());

describe('verifyTurnstileToken', () => {
  it('returns true when siteverify reports success', async () => {
    mockFetch(() => siteverify(true));
    expect(await verifyTurnstileToken('tok', 'secret')).toBe(true);
  });

  it('returns false when siteverify reports failure', async () => {
    mockFetch(() => siteverify(false));
    expect(await verifyTurnstileToken('tok', 'secret')).toBe(false);
  });

  it('fails closed on a non-2xx response', async () => {
    mockFetch(() => new Response('nope', { status: 500 }));
    expect(await verifyTurnstileToken('tok', 'secret')).toBe(false);
  });

  it('fails closed when the fetch throws', async () => {
    mockFetch(() => {
      throw new Error('network');
    });
    expect(await verifyTurnstileToken('tok', 'secret')).toBe(false);
  });

  it('passes secret, response, and remoteip to siteverify', async () => {
    let body: FormData | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: { body?: unknown }) => {
        body = init?.body as FormData;
        return siteverify(true);
      }),
    );
    await verifyTurnstileToken('tok', 'sekret', '1.2.3.4');
    expect(body?.get('secret')).toBe('sekret');
    expect(body?.get('response')).toBe('tok');
    expect(body?.get('remoteip')).toBe('1.2.3.4');
  });
});

describe('turnstileRejection', () => {
  it('is a no-op (null) when TURNSTILE_SECRET is unset — dev/staging', async () => {
    mockFetch(() => siteverify(false)); // must not be consulted
    expect(await turnstileRejection(req(), {})).toBeNull();
  });

  it('rejects 403 when the token header is missing', async () => {
    const r = await turnstileRejection(req(), { TURNSTILE_SECRET: 's' });
    expect(r?.status).toBe(403);
    expect(r?.error).toMatch(/робот/);
  });

  it('proceeds (null) when the token verifies', async () => {
    mockFetch(() => siteverify(true));
    const r = await turnstileRejection(req({ [TURNSTILE_TOKEN_HEADER]: 'tok' }), {
      TURNSTILE_SECRET: 's',
    });
    expect(r).toBeNull();
  });

  it('rejects 403 when the token fails verification', async () => {
    mockFetch(() => siteverify(false));
    const r = await turnstileRejection(req({ [TURNSTILE_TOKEN_HEADER]: 'bad' }), {
      TURNSTILE_SECRET: 's',
    });
    expect(r?.status).toBe(403);
    expect(r?.error).toMatch(/сигурност/);
  });
});
