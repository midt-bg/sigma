import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TURNSTILE_TOKEN_HEADER,
  nextTurnstileToken,
  setTurnstileMinter,
  withTurnstileHeader,
} from './turnstile-token';
import { classifyingFetch } from './useAssistantChat';

afterEach(() => {
  setTurnstileMinter(null);
  vi.unstubAllGlobals();
});

describe('withTurnstileHeader', () => {
  it('sets the token header and preserves existing headers', () => {
    const h = withTurnstileHeader({ 'Content-Type': 'application/json' }, 'tok');
    expect(h.get(TURNSTILE_TOKEN_HEADER)).toBe('tok');
    expect(h.get('Content-Type')).toBe('application/json');
  });
});

describe('nextTurnstileToken', () => {
  it('returns null when no minter is registered', async () => {
    expect(await nextTurnstileToken()).toBeNull();
  });

  it('returns the minted token', async () => {
    setTurnstileMinter(() => Promise.resolve('fresh'));
    expect(await nextTurnstileToken()).toBe('fresh');
  });

  it('returns null when the minter rejects (fail open on the client)', async () => {
    setTurnstileMinter(() => Promise.reject(new Error('boom')));
    expect(await nextTurnstileToken()).toBeNull();
  });
});

describe('classifyingFetch Turnstile header', () => {
  function captureInit(): () => RequestInit | undefined {
    let init: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, i?: RequestInit) => {
        init = i;
        return Promise.resolve(new Response('ok', { status: 200 }));
      }),
    );
    return () => init;
  }

  it('attaches the token header when the gate is active', async () => {
    setTurnstileMinter(() => Promise.resolve('T'));
    const getInit = captureInit();
    await classifyingFetch('/assistant/chat', { method: 'POST' });
    expect(new Headers(getInit()?.headers).get(TURNSTILE_TOKEN_HEADER)).toBe('T');
  });

  it('omits the header when no token is available', async () => {
    const getInit = captureInit();
    await classifyingFetch('/assistant/chat', { method: 'POST' });
    expect(new Headers(getInit()?.headers).has(TURNSTILE_TOKEN_HEADER)).toBe(false);
  });
});
