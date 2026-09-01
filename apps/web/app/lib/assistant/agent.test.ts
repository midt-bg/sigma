import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeD1 } from '@sigma/test-support';

// agent.ts is thin Vercel-AI-SDK wiring. Mock the SDK and provider so the tests can assert the wiring
// (model/base-URL resolution, tool-set assembly, stream Response + onError message) without a live
// BgGPT call. resolveMaxSteps is pure and needs no mocks. The `ai` mock SPREADS the real module:
// agent.ts also imports APICallError/RetryError from it for the stream-error logger, and a mock that
// replaced the module wholesale would turn those into `undefined` and crash every onError path.
const { streamTextMock, createOpenAIMock, chatMock } = vi.hoisted(() => {
  const chatMock = vi.fn((model: string) => ({ model }));
  return {
    chatMock,
    createOpenAIMock: vi.fn(() => ({ chat: chatMock })),
    streamTextMock: vi.fn(),
  };
});
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: createOpenAIMock }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  convertToModelMessages: vi.fn(async (m: unknown) => m),
  jsonSchema: vi.fn((s: unknown) => s),
  stepCountIs: vi.fn((n: number) => ({ stopAt: n })),
  streamText: (o: unknown) => streamTextMock(o),
  tool: (def: unknown) => def,
}));

import { makeStreamErrorLogger, resolveMaxSteps, runAssistant } from './agent';
import { ASSISTANT_TOOLS } from './tools';

describe('resolveMaxSteps', () => {
  it('uses the default for a missing or non-numeric value', () => {
    expect(resolveMaxSteps(undefined)).toBe(6);
    expect(resolveMaxSteps('')).toBe(6);
    expect(resolveMaxSteps('abc')).toBe(6);
  });

  it('falls back to the default for 0 or a negative value (never stalls the loop)', () => {
    expect(resolveMaxSteps('0')).toBe(6);
    expect(resolveMaxSteps('-4')).toBe(6);
  });

  it('clamps an over-large value to the hard ceiling (never uncaps BgGPT calls)', () => {
    expect(resolveMaxSteps('9999')).toBe(20);
  });

  it('passes a sane in-range value through (flooring fractions)', () => {
    expect(resolveMaxSteps('3')).toBe(3);
    expect(resolveMaxSteps('20')).toBe(20);
    expect(resolveMaxSteps('4.9')).toBe(4);
  });
});

describe('runAssistant (SDK wiring)', () => {
  // The SDK is mocked here; nothing in these tests may reach D1. A route-less double throws on
  // any query rather than silently answering one.
  const ctx = { db: fakeD1([]).db, results: [] };

  beforeEach(() => {
    vi.clearAllMocks();
    streamTextMock.mockReturnValue({
      // Exercise onError so its Bulgarian degradation message is covered.
      toUIMessageStreamResponse: (cfg: { onError: (e: unknown) => string }) =>
        new Response(String(cfg.onError(new Error('boom')))),
    });
  });

  it('wires BgGPT through the AI Gateway and returns a UI-message stream Response', async () => {
    const res = await runAssistant({
      env: {
        BGGPT_API_KEY: 'k',
        AI_GATEWAY_BASE_URL: 'https://gw.example/v1',
        BGGPT_MODEL: 'custom-model',
        MAX_STEPS: '3',
      },
      ctx,
      messages: [],
    });
    expect(res).toBeInstanceOf(Response);
    expect(await res.text()).toContain('временно не е достъпен'); // onError message surfaced
    expect(createOpenAIMock).toHaveBeenCalledWith({
      baseURL: 'https://gw.example/v1',
      apiKey: 'k',
    });
    expect(chatMock).toHaveBeenCalledWith('custom-model');
    const opts = streamTextMock.mock.calls[0]![0];
    expect(opts.stopWhen).toEqual({ stopAt: 3 });
    expect(opts.maxRetries).toBe(1);
    expect(opts.maxOutputTokens).toBe(4096);
  });

  it('falls back to the default base URL and model when env omits them', async () => {
    await runAssistant({ env: { BGGPT_API_KEY: 'k' }, ctx, messages: [] });
    expect(createOpenAIMock).toHaveBeenCalledWith({
      baseURL: 'https://api.bggpt.ai/v1',
      apiKey: 'k',
    });
    expect(chatMock).toHaveBeenCalledWith('bggpt-gemma-3-27b-fp8');
  });

  it('assembles every registry tool plus the terminal emit_report tool', async () => {
    await runAssistant({ env: { BGGPT_API_KEY: 'k' }, ctx, messages: [] });
    const tools = streamTextMock.mock.calls[0]![0].tools;
    expect(tools.emit_report).toBeDefined();
    for (const t of ASSISTANT_TOOLS) expect(tools[t.name]).toBeDefined();

    // Invoke a regular tool's execute closure (covers the input ?? {} default); tolerate the runtime
    // error the real tool throws against the empty fake ctx — only the wiring is under test here.
    await tools[ASSISTANT_TOOLS[0]!.name].execute(undefined).catch(() => {});

    // emit_report.execute → finalizeReport; invalid input returns the validation-error branch.
    const r = await tools.emit_report.execute({ not: 'a valid report' });
    expect(r.ok).toBe(false);
    expect(Array.isArray(r.errors)).toBe(true);
  });
});

describe('makeStreamErrorLogger', () => {
  const capture = () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((l: unknown) => {
      lines.push(String(l));
    });
    return { lines, restore: () => spy.mockRestore() };
  };

  it('logs an object error once even though both stream hooks report it', () => {
    const { lines, restore } = capture();
    const log = makeStreamErrorLogger([]);
    const err = new Error('провайдърът падна');
    log(err);
    log(err); // the second hook sees the SAME object
    restore();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('провайдърът падна');
  });

  it('logs a PRIMITIVE throw once too — it has no identity for a WeakSet to key on', () => {
    const { lines, restore } = capture();
    const log = makeStreamErrorLogger([]);
    log('низова грешка');
    log('низова грешка');
    restore();
    expect(lines).toHaveLength(1);
  });

  it('still logs two DISTINCT object errors that render the same text', () => {
    const { lines, restore } = capture();
    const log = makeStreamErrorLogger([]);
    log(new Error('една и съща фраза'));
    log(new Error('една и съща фраза'));
    restore();
    expect(lines).toHaveLength(2);
  });

  it('redacts the question before it reaches the log line', () => {
    const { lines, restore } = capture();
    const question = 'колко плати община Пловдив на фирма Х';
    makeStreamErrorLogger([question])(new Error(`400: ${question}`));
    restore();
    expect(lines[0]).not.toContain('Пловдив');
  });
});
