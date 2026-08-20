import { afterEach, describe, expect, it, vi } from 'vitest';

// The narrative generator and the role-④ verifier generator share a provider but MUST carry different
// generation params: the narrative gets a little variety (temp 0.3), the verifier must be deterministic
// JSON (temp 0) or a small quantized model drifts into prose and returns no JSON object at all — which
// fail-closes and strips the narrative we just produced (the drift bug this suite guards against). These
// tests mock the model layer to capture exactly what each builder passes to `generateText`.

const generateTextMock = vi.fn(
  async (_opts: Record<string, unknown>): Promise<{ text: string; finishReason?: string }> => ({
    text: '{}',
  }),
);
const chatMock = vi.fn(() => 'FAKE_MODEL');
const createOpenAIMock = vi.fn((_opts: Record<string, unknown>) => ({ chat: chatMock }));

vi.mock('ai', () => ({
  generateText: (opts: Record<string, unknown>) => generateTextMock(opts),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: (opts: Record<string, unknown>) => createOpenAIMock(opts),
}));

// Import AFTER the mocks are registered so the builders bind to the mocked modules.
const { buildDigestGenerate, buildDigestVerifierGenerate } = await import('./weekly-digest');

const ENV = {
  DB: {} as never,
  REPORTS: {} as never,
  AI_GATEWAY_BASE_URL: 'https://gateway.example/v1/acct/sigma-assistant/custom-bggpt/v1',
  ASSISTANT_MODEL: 'bggpt-gemma4-31b-it-bg-gptq-w4a16',
  ASSISTANT_API_KEY: 'k',
};

afterEach(() => {
  generateTextMock.mockClear();
  chatMock.mockClear();
  createOpenAIMock.mockClear();
});

describe('weekly-digest model generation params', () => {
  it('narrative generator: temperature 0.3, 1400-token cap (≥5-paragraph analysis), no retries, bounded by a timeout', async () => {
    await buildDigestGenerate(ENV)({ system: 's', prompt: 'p' });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const opts = generateTextMock.mock.calls[0]![0];
    expect(opts.temperature).toBe(0.3);
    expect(opts.maxOutputTokens).toBe(1400);
    expect(opts.maxRetries).toBe(0);
    // The cron has no request signal, so the narrative call carries its own abort budget (a hung gateway
    // call must not stall the worker — mirrors the verifier).
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('narrative generator THROWS on a truncated (finishReason=length) draft, so it never publishes a mid-sentence narrative', async () => {
    // A token-cap hit returns partial text with finishReason 'length'. The builder must throw (the
    // orchestrator catches it → retry → AI-free fallback) rather than return the truncated fragment,
    // which the grounding-only verifier would pass and publish into the immutable artifact.
    generateTextMock.mockResolvedValueOnce({
      text: 'Изминалата седмица беше',
      finishReason: 'length',
    });
    await expect(buildDigestGenerate(ENV)({ system: 's', prompt: 'p' })).rejects.toThrow(
      /finishReason=length/,
    );
  });

  it('narrative generator returns the text on a normal (stop) finish', async () => {
    generateTextMock.mockResolvedValueOnce({ text: 'Пълен разказ.', finishReason: 'stop' });
    await expect(buildDigestGenerate(ENV)({ system: 's', prompt: 'p' })).resolves.toBe(
      'Пълен разказ.',
    );
  });

  it('verifier generator: temperature 0 (deterministic JSON), 1024-token cap, bounded by a timeout', async () => {
    await buildDigestVerifierGenerate(ENV)({ system: 's', prompt: 'p' });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const opts = generateTextMock.mock.calls[0]![0];
    expect(opts.temperature).toBe(0);
    expect(opts.maxOutputTokens).toBe(1024);
    expect(opts.maxRetries).toBe(0);
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
  });

  // The verifier over-strips grounded ranking prose under @sigma/report's generic VERIFIER_SYSTEM, so
  // the digest substitutes its own sharpened prompt: verifyReport hands the generic system in, the
  // digest generator ignores it and uses DIGEST_VERIFIER_SYSTEM (which reserves "unsupported" for
  // contradictions and biases to "uncertain"). The narrative generator, by contrast, must pass its
  // caller's system (DIGEST_SYSTEM_PROMPT) straight through.
  it('verifier generator substitutes the digest-tuned system prompt, ignoring the generic one', async () => {
    await buildDigestVerifierGenerate(ENV)({ system: 'GENERIC_SHARED_SYSTEM', prompt: 'p' });
    const opts = generateTextMock.mock.calls[0]![0];
    expect(opts.system).not.toBe('GENERIC_SHARED_SYSTEM');
    expect(opts.system).toContain('CONTRADICTS'); // unsupported reserved for contradictions
    expect(opts.system).toContain('"uncertain"'); // hedge keeps the block
  });

  it('narrative generator passes the caller system through unchanged', async () => {
    await buildDigestGenerate(ENV)({ system: 'NARRATIVE_SYSTEM', prompt: 'p' });
    const opts = generateTextMock.mock.calls[0]![0];
    expect(opts.system).toBe('NARRATIVE_SYSTEM');
  });

  it('both refuse to build when AI_GATEWAY_BASE_URL is unset (never bypass the gateway)', () => {
    const bare = { ...ENV, AI_GATEWAY_BASE_URL: undefined };
    expect(() => buildDigestGenerate(bare)).toThrow(/AI_GATEWAY_BASE_URL/);
    expect(() => buildDigestVerifierGenerate(bare)).toThrow(/AI_GATEWAY_BASE_URL/);
  });

  // BgGPT dumps its chain-of-thought as plain content unless thinking is disabled at the chat-template
  // level; the provider's fetch wrapper must inject chat_template_kwargs.enable_thinking=false into every
  // outgoing request body. BOTH generators use it: the narrative for a clean sentence, the verifier so
  // its reasoning never eats the token budget before the JSON verdicts (which returns "no JSON object").
  it.each([
    ['narrative', buildDigestGenerate],
    ['verifier', buildDigestVerifierGenerate],
  ])(
    '%s generator: provider fetch injects chat_template_kwargs.enable_thinking=false',
    async (_n, build) => {
      build(ENV);
      const wrappedFetch = createOpenAIMock.mock.calls[0]![0].fetch as typeof fetch;
      expect(typeof wrappedFetch).toBe('function');

      const seen: Array<Record<string, unknown>> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: unknown, init: { body?: string }) => {
          seen.push(JSON.parse(init.body ?? '{}'));
          return new Response('{}');
        }),
      );
      try {
        await wrappedFetch('https://gw.example/chat/completions', {
          method: 'POST',
          body: JSON.stringify({ model: 'm', messages: [] }),
        });
      } finally {
        vi.unstubAllGlobals();
      }

      expect(seen).toHaveLength(1);
      expect((seen[0]!.chat_template_kwargs as Record<string, unknown>).enable_thinking).toBe(
        false,
      );
      // The original body is preserved, not clobbered.
      expect(seen[0]!.model).toBe('m');
    },
  );
});
