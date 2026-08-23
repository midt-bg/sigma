import { afterEach, describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { runAssistant } from './agent';
import type { ToolContext } from './tools';

// The ONLY test that drives runAssistant through the real streamText loop. It exists for one
// invariant the unit tests cannot see: the AI SDK's own DEFAULT `onError` is `console.error(error)`
// — the RAW APICallError, whose own properties carry `requestBodyValues` (system prompt + the user's
// messages) and `responseBody`. If agent.ts stops overriding it on streamText (not only on the UI
// stream), the prompt lands in the tail log on every provider failure, and nothing else notices.
const h = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () => ({ chat: () => h.model }),
}));

const QUESTION = 'колко плати община Пловдив на фирма Х през 2024';

function failingModel(statusCode: number, isRetryable: boolean) {
  return new MockLanguageModelV3({
    doStream: async () => {
      throw new APICallError({
        // A provider body that quotes the prompt back — the echo sits in `.message`.
        message: `upstream rejected: ${QUESTION}`,
        url: 'https://api.bggpt.ai/v1/chat/completions',
        requestBodyValues: { messages: [{ role: 'user', content: QUESTION }] },
        statusCode,
        responseBody: `{"error":{"message":"${QUESTION}"}}`,
        isRetryable,
      });
    },
  });
}

function ctx(): ToolContext {
  return {
    db: {} as never,
    results: [],
    rowsRead: 0,
    rowsReadBudget: 1000,
    userQuestion: QUESTION,
  };
}

async function runToEnd(): Promise<string> {
  const res = await runAssistant({
    env: { BGGPT_API_KEY: 'k', MAX_STEPS: '1' },
    ctx: ctx(),
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: QUESTION }] }],
  });
  return res.text(); // draining the body drives the stream (and its error hooks) to completion
}

describe('runAssistant stream error logging', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs ONE redacted, tagged line and NEVER the raw error object (non-retryable 401)', async () => {
    h.model = failingModel(401, false);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await runToEnd();

    // What the client sees: our line, not the provider's.
    expect(body).toContain('Асистентът временно не е достъпен');
    expect(body).not.toContain('Пловдив');

    // What the tail log sees: exactly one line, a string, redacted, with identifier-only context.
    expect(error).toHaveBeenCalledTimes(1);
    const [first] = error.mock.calls[0] ?? [];
    expect(typeof first).toBe('string'); // the SDK default would pass the Error OBJECT here
    expect(first).toMatch(/^\[assistant\] stream error: /);
    expect(first).toContain('«редактирано»');
    expect(first).toContain('status=401');
    expect(first).toContain('retryable=false');
    for (const call of error.mock.calls) {
      for (const arg of call) {
        expect(typeof arg).toBe('string');
        expect(String(arg)).not.toContain('Пловдив');
        expect(String(arg)).not.toContain('requestBodyValues');
      }
    }
  });

  it('keeps the status visible through the RetryError wrapper (retryable 429, maxRetries 1)', async () => {
    h.model = failingModel(429, true);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runToEnd();
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]?.[0]);
    expect(line).toContain('RetryError maxRetriesExceeded');
    expect(line).toContain('status=429');
    expect(line).not.toContain('Пловдив');
  });
});
