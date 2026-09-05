import { afterEach, describe, expect, it, vi } from 'vitest';

// Route-door tests for the corpus health/provisioning endpoint (#328, #346): the ONE thing the deploy
// step and an operator's curl ever see. The provisioning logic is pinned in rag.test.ts; this proves the
// route wires it to real-looking bindings, answers with counters only, and never caches or echoes.
import { loader } from './assistant.health';
import {
  buildSchemaChunks,
  EMBED_DIM,
  resetCorpusIndexingMemo,
  SCHEMA_NS,
  schemaVectorId,
} from '../lib/assistant/rag';

const VEC = new Array(EMBED_DIM).fill(0.1);
const chunks = buildSchemaChunks();
// What getByIds returns once this build's corpus is fully applied.
const complete = () =>
  chunks.map((c) => ({
    id: schemaVectorId(c),
    values: VEC,
    namespace: SCHEMA_NS,
    metadata: { text: c.text },
  }));

function fakeAI(run?: () => Promise<unknown>) {
  return {
    run: vi.fn(
      run ??
        (async (_model: string, inputs: { text: string[] }) => ({
          data: inputs.text.map(() => VEC),
        })),
    ),
  };
}

function fakeVectorize(found: unknown[]) {
  return {
    upsert: vi.fn(async (_vectors: unknown[]) => ({ count: 0 })),
    query: vi.fn(async () => ({ matches: [] })),
    getByIds: vi.fn(async () => found),
  };
}

function run(env: Record<string, unknown>) {
  return (
    loader as unknown as (a: {
      request: Request;
      context: unknown;
      params: Record<string, never>;
    }) => Promise<Response>
  )({
    request: new Request('https://sigma.test/assistant/health'),
    context: { cloudflare: { env } },
    params: {},
  });
}

describe('GET /assistant/health (route door)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetCorpusIndexingMemo();
  });

  it('answers 200 with counters only when every expected vector is readable, and writes nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const AI = fakeAI();
    const VECTORIZE = fakeVectorize(complete());
    const res = await run({ AI, VECTORIZE });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({
      ns: SCHEMA_NS,
      expected: chunks.length,
      present: chunks.length,
      stale: 0,
      lean: 0,
      upserted: 0,
    });
    expect(VECTORIZE.upsert).not.toHaveBeenCalled();
    expect(AI.run).not.toHaveBeenCalled();
    const lines = log.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('assistant.index'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      evt: 'assistant.index',
      ns: SCHEMA_NS,
      expected: chunks.length,
      present: chunks.length,
      stale: 0,
      lean: 0,
      upserted: 0,
    });
  });

  it('provisions a cold environment on the call itself and answers 503 until a re-read confirms it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const AI = fakeAI();
    const VECTORIZE = fakeVectorize([]);
    const res = await run({ AI, VECTORIZE });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ns: SCHEMA_NS,
      expected: chunks.length,
      present: 0,
      stale: 0,
      lean: 0,
      upserted: chunks.length,
    });
    // The writes are exactly this build's corpus, in the versioned namespace.
    expect(VECTORIZE.upsert).toHaveBeenCalledTimes(1);
    const written = VECTORIZE.upsert.mock.calls[0]?.[0] as { id: string; namespace?: string }[];
    expect(written.map((v) => v.id)).toEqual(chunks.map(schemaVectorId));
    expect(written.every((v) => v.namespace === SCHEMA_NS)).toBe(true);
    // A second call while reads still lag (Vectorize applies writes asynchronously) does NOT re-embed.
    const again = await run({ AI, VECTORIZE });
    expect(again.status).toBe(503);
    expect(AI.run).toHaveBeenCalledTimes(1);
  });

  it('answers 503 "unprovisioned" without bindings and 503 "unavailable" on a provider failure — never its message', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bare = await run({});
    expect(bare.status).toBe(503);
    expect(await bare.json()).toEqual({ error: 'unprovisioned' });
    const VECTORIZE = fakeVectorize([]);
    const AI = fakeAI(async () => {
      throw new Error('quota exceeded for account acct_123');
    });
    const res = await run({ AI, VECTORIZE });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: 'unavailable' }));
    expect(text).not.toContain('acct_123');
    expect(error.mock.calls.some((c) => String(c[0]).includes('corpus check failed'))).toBe(true);
  });
});
