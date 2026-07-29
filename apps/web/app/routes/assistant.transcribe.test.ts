import { afterEach, describe, expect, it, vi } from 'vitest';
import { action } from './assistant.transcribe';
import { WHISPER_MODEL } from '../lib/assistant/transcribe';

// Route.ActionArgs carries more, but the action reads only request + context.cloudflare.env — a typed cast
// at this test boundary is honest (same pattern as assistant.prompts.test.ts).
function makeArgs(request: Request, env: unknown) {
  return { request, context: { cloudflare: { env } } } as unknown as Parameters<typeof action>[0];
}

const postJson = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://local/assistant/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const AUDIO = { audio: 'YWJj', mime: 'audio/webm' }; // base64 'abc'
const whisperRun = (text: string) => vi.fn(async () => ({ text }));
const jsonResponse = (obj: unknown) =>
  new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
// Both providers present + enabled, overridable per test.
const env = (over: Record<string, unknown> = {}) => ({
  ASSISTANT_ENABLED: 'true',
  ASSISTANT_API_KEY: 'k',
  AI_GATEWAY_ID: 'sigma-assistant',
  BGGPT_STT_BASE_URL: 'https://gateway.example/v1/acct/sigma-assistant/custom-bggpt-voice',
  AI: { run: whisperRun('unused') },
  ...over,
});

const UNCONFIGURED = 'Гласовото въвеждане не е конфигурирано.';
const TRANSCRIBE_FAILED = 'Разпознаването на говор не бе успешно.';

afterEach(() => vi.restoreAllMocks());

describe('assistant.transcribe action', () => {
  it('transcribes via BgGPT (default primary) and does NOT touch Workers AI', async () => {
    const run = whisperRun('unused');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ text: 'Купи хляб' }));
    const res = await action(makeArgs(postJson(AUDIO), env({ AI: { run } })));

    expect(fetchSpy).toHaveBeenCalledOnce();
    // cf-aig-collect-log:false keeps the audio out of the gateway logs (load-bearing, ADR-0013).
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/audio/transcriptions'),
      expect.objectContaining({
        headers: expect.objectContaining({ 'cf-aig-collect-log': 'false' }),
      }),
    );
    expect(run).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ text: 'Купи хляб', source: 'bggpt' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('logs a metadata-only outcome line (source + fellBack, never the transcript)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ text: 'Купи хляб' }));
    await action(makeArgs(postJson(AUDIO), env()));

    const line = logSpy.mock.calls
      .map((c) => c[0])
      .find((s): s is string => typeof s === 'string' && s.includes('transcribe'));
    // toStrictEqual (exact keys) proves the log carries no transcript/audio field. bytes = len('YWJj').
    expect(JSON.parse(line ?? '{}')).toStrictEqual({
      evt: 'transcribe',
      source: 'bggpt',
      fellBack: false,
      bytes: 4,
    });
  });

  it('falls back to Workers AI through the gateway (collectLog off) when BgGPT fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = whisperRun('от Workers AI');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 502 }));
    const res = await action(makeArgs(postJson(AUDIO), env({ AI: { run } })));

    // The fallback binding is routed through the gateway with collectLog:false — metadata logged, audio not.
    expect(run).toHaveBeenCalledWith(
      WHISPER_MODEL,
      { audio: 'YWJj', language: 'bg' },
      { gateway: { id: 'sigma-assistant', collectLog: false } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ text: 'от Workers AI', source: 'workers-ai' });
  });

  it('falls back to Workers AI when BgGPT returns an empty transcript (shape drift)', async () => {
    const run = whisperRun('от Workers AI');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ text: '' }));
    const res = await action(makeArgs(postJson(AUDIO), env({ AI: { run } })));

    expect(run).toHaveBeenCalledOnce();
    expect(await res.json()).toStrictEqual({ text: 'от Workers AI', source: 'workers-ai' });
  });

  it('honours TRANSCRIBE_PRIMARY=workers-ai (Workers AI first, BgGPT untouched)', async () => {
    const run = whisperRun('от Workers AI');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await action(
      makeArgs(postJson(AUDIO), env({ AI: { run }, TRANSCRIBE_PRIMARY: 'workers-ai' })),
    );

    expect(run).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await res.json()).toStrictEqual({ text: 'от Workers AI', source: 'workers-ai' });
  });

  it('uses Workers AI when BgGPT is not configured (no key)', async () => {
    const run = whisperRun('от Workers AI');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await action(
      makeArgs(postJson(AUDIO), { ASSISTANT_ENABLED: 'true', AI: { run } }), // no ASSISTANT_API_KEY
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await res.json()).toStrictEqual({ text: 'от Workers AI', source: 'workers-ai' });
  });

  it('skips BgGPT when BGGPT_STT_BASE_URL is unset (fail-closed to Workers AI, no api.bggpt.ai direct)', async () => {
    const run = whisperRun('от Workers AI');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await action(
      makeArgs(postJson(AUDIO), env({ AI: { run }, BGGPT_STT_BASE_URL: undefined })),
    );

    // No base URL ⇒ BgGPT is skipped entirely (never a hardcoded direct-API fallback); Workers AI serves.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await res.json()).toStrictEqual({ text: 'от Workers AI', source: 'workers-ai' });
  });

  it('degrades to Workers AI when the BgGPT circuit-breaker is open (no BgGPT spend)', async () => {
    const run = whisperRun('от Workers AI');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const openBreaker = {
      idFromName: () => 'global',
      get: () => ({ admit: async () => ({ allowed: false }) }),
    };
    const res = await action(
      makeArgs(postJson(AUDIO), env({ AI: { run }, BGGPT_CIRCUIT_BREAKER: openBreaker })),
    );

    // Breaker consulted before the paid fetch ⇒ BgGPT skipped (no external call), Workers AI serves.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    expect(await res.json()).toStrictEqual({ text: 'от Workers AI', source: 'workers-ai' });
  });

  it('429s when the BgGPT circuit-breaker is open and no fallback can serve', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const openBreaker = {
      idFromName: () => 'global',
      get: () => ({ admit: async () => ({ allowed: false }) }),
    };
    const res = await action(
      makeArgs(postJson(AUDIO), env({ AI: undefined, BGGPT_CIRCUIT_BREAKER: openBreaker })),
    );

    // No Workers AI fallback ⇒ the breaker's 429 surfaces; the paid BgGPT fetch never runs.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.status).toBe(429);
  });

  it('503s when both providers fail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = vi.fn(async () => {
      throw new Error('ai down');
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 502 }));
    const res = await action(makeArgs(postJson(AUDIO), env({ AI: { run } })));

    expect(res.status).toBe(503);
    expect(await res.json()).toStrictEqual({ error: TRANSCRIBE_FAILED });
  });

  it('503s (unconfigured) when no provider is available', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await action(makeArgs(postJson(AUDIO), { ASSISTANT_ENABLED: 'true' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toStrictEqual({ error: UNCONFIGURED });
  });

  it('strips control/bidi chars from the transcript before returning it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ text: 'a\u202Eb' })); // embedded RLO
    const res = await action(makeArgs(postJson(AUDIO), env()));
    expect(await res.json()).toStrictEqual({ text: 'ab', source: 'bggpt' });
  });

  it('503s and touches no provider when the kill switch is off', async () => {
    const run = whisperRun('x');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await action(makeArgs(postJson(AUDIO), { ASSISTANT_API_KEY: 'k', AI: { run } }));
    expect(res.status).toBe(503);
    expect(await res.json()).toStrictEqual({ error: 'Асистентът не е активен.' });
    expect(run).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('415s a non-JSON content-type before transcribing (CSRF gate)', async () => {
    const run = whisperRun('x');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await action(
      makeArgs(postJson(AUDIO, { 'Content-Type': 'text/plain' }), env({ AI: { run } })),
    );
    expect(res.status).toBe(415);
    expect(run).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('403s an explicit cross-site request before transcribing', async () => {
    const run = whisperRun('x');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await action(
      makeArgs(postJson(AUDIO, { 'Sec-Fetch-Site': 'cross-site' }), env({ AI: { run } })),
    );
    expect(res.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('405s a non-POST method before transcribing', async () => {
    const run = whisperRun('x');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const req = new Request('http://local/assistant/transcribe', { method: 'GET' });
    const res = await action(makeArgs(req, env({ AI: { run } })));
    expect(res.status).toBe(405);
    expect(run).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('413s an over-cap body (measured bytes) before transcribing', async () => {
    const run = whisperRun('x');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const huge = { audio: 'A'.repeat(4 * 1024 * 1024), mime: 'audio/webm' };
    const res = await action(makeArgs(postJson(huge), env({ AI: { run } })));
    expect(res.status).toBe(413);
    expect(run).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('400s invalid JSON before transcribing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await action(makeArgs(postJson('not json'), env()));
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('400s a missing audio field before transcribing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await action(makeArgs(postJson({ mime: 'audio/webm' }), env()));
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('415s a disallowed audio mime before transcribing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await action(makeArgs(postJson({ audio: 'YWJj', mime: 'audio/wav' }), env()));
    expect(res.status).toBe(415);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
