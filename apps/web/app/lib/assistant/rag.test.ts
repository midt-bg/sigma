import { describe, expect, it, vi } from 'vitest';
import {
  buildSchemaChunks,
  embed,
  EMBED_DIM,
  indexSchemaCorpus,
  MAX_EMBED_CHARS,
  retrieveSchemaContext,
  semanticSearch,
  type EmbeddingRunner,
  type VectorIndex,
} from './rag';

const vec = () => Array.from({ length: EMBED_DIM }, () => 0.1);

function fakeAI(opts: { count?: (n: number) => number; capture?: (texts: string[]) => void } = {}) {
  return {
    run: vi.fn(async (_model: string, inputs: { text: string[] }) => {
      opts.capture?.(inputs.text);
      const n = opts.count ? opts.count(inputs.text.length) : inputs.text.length;
      return { data: Array.from({ length: n }, vec) };
    }),
  } satisfies EmbeddingRunner;
}

type Match = { id: string; score: number; metadata?: Record<string, unknown> };
function fakeIndex(matches: Match[] = []) {
  const upserted: unknown[] = [];
  return {
    upserted,
    upsert: vi.fn(async (vectors: unknown[]) => {
      upserted.push(...vectors);
    }),
    query: vi.fn(async () => ({ matches })),
  } satisfies VectorIndex & { upserted: unknown[] };
}

describe('buildSchemaChunks', () => {
  it('includes traps, queries and tables', () => {
    const chunks = buildSchemaChunks();
    expect(chunks.some((c) => c.kind === 'trap')).toBe(true);
    expect(chunks.some((c) => c.kind === 'query')).toBe(true);
    expect(chunks.some((c) => c.kind === 'table')).toBe(true);
  });
});

describe('embed', () => {
  it('returns [] for no input without calling the model', async () => {
    const ai = fakeAI();
    expect(await embed(ai, [])).toEqual([]);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('caps each text to MAX_EMBED_CHARS before embedding', async () => {
    let seen: string[] = [];
    const ai = fakeAI({ capture: (t) => (seen = t) });
    await embed(ai, ['x'.repeat(MAX_EMBED_CHARS + 500)]);
    expect(seen[0]!.length).toBe(MAX_EMBED_CHARS);
  });

  it('throws when the provider returns a mismatched vector count', async () => {
    const ai = fakeAI({ count: () => 0 });
    await expect(embed(ai, ['a', 'b'])).rejects.toThrow(/expected 2 vectors/);
  });
});

describe('indexSchemaCorpus', () => {
  it('upserts one vector per chunk in the schema namespace', async () => {
    const ai = fakeAI();
    const index = fakeIndex();
    const n = await indexSchemaCorpus(ai, index);
    expect(n).toBe(buildSchemaChunks().length);
    expect(index.upserted).toHaveLength(n);
    expect((index.upserted[0] as { metadata: { ns: string } }).metadata.ns).toBe('schema');
  });
});

describe('retrieveSchemaContext', () => {
  it('returns the matched chunk texts and queries the schema namespace', async () => {
    const ai = fakeAI();
    const index = fakeIndex([
      { id: 'schema:trap:0', score: 0.9, metadata: { text: 'СУМИРАЙ САМО amount_eur' } },
    ]);
    expect(await retrieveSchemaContext(ai, index, 'обща сума')).toEqual([
      'СУМИРАЙ САМО amount_eur',
    ]);
    // Pin the namespace filter — a swapped schema/entity filter would poison the prompt yet still map.
    expect(index.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ filter: { ns: 'schema' } }),
    );
  });
});

describe('semanticSearch', () => {
  it('maps matches into hits and queries the entity namespace', async () => {
    const ai = fakeAI();
    const index = fakeIndex([
      { id: 'e1', score: 0.8, metadata: { kind: 'company', ref: 'eik:1', title: 'Фирма' } },
    ]);
    const out = await semanticSearch(ai, index, 'детски градини');
    expect(out[0]).toMatchObject({ kind: 'company', ref: 'eik:1', title: 'Фирма', score: 0.8 });
    expect(index.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ filter: { ns: 'entity' } }),
    );
  });
});
