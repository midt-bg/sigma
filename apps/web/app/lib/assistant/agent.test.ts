import { beforeEach, describe, expect, it, vi } from 'vitest';

// agent.ts is thin Vercel-AI-SDK wiring. Mock the SDK and provider so the tests can assert the wiring
// (model/base-URL resolution, tool-set assembly, stream Response + onError message) without a live
// BgGPT call. resolveMaxSteps is pure and needs no mocks.
const { streamTextMock, createOpenAIMock, chatMock } = vi.hoisted(() => {
  const chatMock = vi.fn((model: string) => ({ model }));
  return {
    chatMock,
    createOpenAIMock: vi.fn(() => ({ chat: chatMock })),
    streamTextMock: vi.fn(),
  };
});
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: createOpenAIMock }));
vi.mock('ai', () => ({
  convertToModelMessages: vi.fn(async (m: unknown) => m),
  jsonSchema: vi.fn((s: unknown) => s),
  stepCountIs: vi.fn((n: number) => ({ stopAt: n })),
  streamText: (o: unknown) => streamTextMock(o),
  tool: (def: unknown) => def,
}));

import { resolveMaxSteps, runAssistant } from './agent';
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
  const ctx = { db: {} as D1Database, results: [] };

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
