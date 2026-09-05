import { afterEach, describe, expect, it, vi } from 'vitest';

// Route-door tests for the assistant chat endpoint: the ONE entry point users hit. The RAG/stats/
// log-safety units are each pinned in their own test files; this file proves the route's GLUE —
// that the route actually passes the question for redaction, actually emits the stats line, and
// actually degrades to a 503 — because a call site that forgets an argument is invisible to every
// unit test (the unit is correct; the caller is not). runAssistant is mocked: the BgGPT loop is
// exercised separately (agent.stream-error.test.ts); @sigma/db is mocked as in the conflicts tests.
const m = vi.hoisted(() => ({
  runAssistant: vi.fn(),
  getDb: vi.fn((env: { DB: unknown }) => env.DB),
}));
vi.mock('@sigma/db', () => ({ getDb: m.getDb }));
vi.mock('../lib/assistant/agent', () => ({ runAssistant: m.runAssistant }));

import { action } from './assistant.chat';
import { EMBED_MODEL } from '../lib/assistant/rag';

const QUESTION = 'Колко плати Община Пловдив на фирма ТРЕЙС\nпрез 2024 година?';
const VEC = new Array(1024).fill(0.1);

function fakeAI(run?: (model: string, inputs: { text: string[] }) => Promise<unknown>) {
  return { run: vi.fn(run ?? (async () => ({ data: [VEC] }))) };
}

function fakeVectorize(matches: Array<{ id: string; score: number; text: string }>) {
  return {
    upsert: vi.fn(async () => ({ count: 0 })),
    query: vi.fn(async () => ({
      matches: matches.map((x) => ({ id: x.id, score: x.score, metadata: { text: x.text } })),
    })),
  };
}

function post(question = QUESTION): Request {
  return new Request('https://sigma.test/assistant/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: question }] }],
    }),
  });
}

/** A request whose headers are NOT guarded (a real Request drops Content-Length) — for the input checks. */
function postRaw(body: string, headers: Record<string, string> = {}): Request {
  return {
    method: 'POST',
    headers: new Headers({
      'Content-Type': 'application/json',
      'Sec-Fetch-Site': 'same-origin',
      ...headers,
    }),
    text: async () => body,
  } as unknown as Request;
}

function run(env: Record<string, unknown>, request = post()) {
  return (action as unknown as (a: { request: Request; context: unknown }) => Promise<Response>)({
    request,
    context: { cloudflare: { env: { BGGPT_API_KEY: 'k', DB: {}, ...env } } },
  });
}

describe('POST /assistant/chat (route door)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    m.runAssistant.mockReset();
  });

  it('RAG-grounds the turn and emits the counts-only stats line (never the question)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.runAssistant.mockResolvedValue(new Response('ok'));
    const AI = fakeAI();
    const VECTORIZE = fakeVectorize([
      { id: 'a', score: 0.9, text: 'chunk A' },
      { id: 'b', score: 0.1, text: 'chunk B' }, // below MIN_SCHEMA_SCORE → dropped, counted
    ]);

    const res = await run({ AI, VECTORIZE });
    expect(res.status).toBe(200);

    // The embed call carries the route's question, through the typed bridge, to the real model id.
    expect(AI.run).toHaveBeenCalledWith(EMBED_MODEL, { text: [QUESTION] });
    // The agent receives the kept chunks AND the server-authoritative question.
    const opts = m.runAssistant.mock.calls[0]?.[0] as {
      schemaContext?: string[];
      ctx: { userQuestion?: string };
    };
    expect(opts.schemaContext).toEqual(['chunk A']);
    expect(opts.ctx.userQuestion).toBe(QUESTION);
    // Exactly one structured stats line; counts only.
    const stats = log.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('assistant.rag'));
    expect(stats).toHaveLength(1);
    expect(JSON.parse(stats[0] ?? '')).toEqual({
      evt: 'assistant.rag',
      matched: 2,
      aboveFloor: 1,
      kept: 1,
    });
    for (const c of [...log.mock.calls, ...error.mock.calls]) {
      expect(String(c[0])).not.toContain('Пловдив');
    }
  });

  it('redacts the question when the embedding provider echoes it in the RAG-failure log', async () => {
    // The route's RAG catch is the ONE site that embeds the raw question — the likeliest echo.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.runAssistant.mockResolvedValue(new Response('ok'));
    const AI = fakeAI(async (_model, inputs) => {
      throw new Error(`AiError 3010: invalid input — ${inputs.text[0]}`);
    });

    const res = await run({ AI, VECTORIZE: fakeVectorize([]) });
    expect(res.status).toBe(200); // still answers — full-dictionary fallback
    const opts = m.runAssistant.mock.calls[0]?.[0] as { schemaContext?: string[] };
    expect(opts.schemaContext).toBeUndefined();

    const lines = error.mock.calls.map((c) => c.map(String).join(' '));
    const rag = lines.find((l) => l.includes('rag retrieval failed'));
    expect(rag).toBeDefined();
    expect(rag).toContain('«редактирано»');
    expect(rag).toContain('AiError 3010');
    for (const l of lines) expect(l).not.toContain('Пловдив');
  });

  it('degrades a setup-time failure to 503 with a redacted, frame-only log line', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A multi-line message — the shape that used to leak through stackHead's "drop line 0".
    m.runAssistant.mockRejectedValue(new Error(`bad history:\n${QUESTION}\n(code 400)`));

    const res = await run({});
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: expect.stringContaining('временно не е достъпен') });

    const lines = error.mock.calls.map((c) => c.map(String).join(' '));
    const failed = lines.find((l) => l.includes('turn failed to start'));
    expect(failed).toBeDefined();
    expect(failed).toContain('«редактирано»');
    expect(failed).toMatch(/\| at /); // the frame part is there…
    for (const l of lines) expect(l).not.toContain('Пловдив'); // …and carries no message text
  });

  it('rejects bad input at the door: over-cap body (declared or actual), invalid JSON, no turns, one giant turn', async () => {
    const status = async (req: Request) => (await run({}, req)).status;
    const turn = (text: string, role = 'user') => ({
      id: 't',
      role,
      parts: [{ type: 'text', text }],
    });
    // A declared Content-Length above the cap is refused BEFORE the body is buffered…
    expect(await status(postRaw('{}', { 'Content-Length': String(300 * 1024) }))).toBe(413);
    // …and an under-declared one does not help: the UTF-8 byte count of the read body is checked too.
    expect(await status(postRaw(JSON.stringify({ messages: [turn('я'.repeat(140_000))] })))).toBe(
      413,
    );
    expect(await status(postRaw('not json'))).toBe(400);
    expect(await status(postRaw(JSON.stringify({ messages: [] })))).toBe(400);
    // Non-client roles are dropped before the recency slice → no turns left.
    expect(await status(postRaw(JSON.stringify({ messages: [turn('x', 'system')] })))).toBe(400);
    // One message over the per-message cap, even though the body is under the total cap.
    expect(await status(post('a'.repeat(70_000)))).toBe(413);
    expect(m.runAssistant).not.toHaveBeenCalled();
  });

  it('returns 503 before any model work when the endpoint is unprovisioned', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await run({ BGGPT_API_KEY: '' });
    expect(res.status).toBe(503);
    expect(m.runAssistant).not.toHaveBeenCalled();
  });
});
