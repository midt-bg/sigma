import { describe, expect, it, vi } from 'vitest';
import { CANONICAL_QUERIES, TABLES } from './describe-schema';
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
  it('includes queries and tables but NOT traps (traps are always injected via hardTraps)', () => {
    const chunks = buildSchemaChunks();
    expect(chunks.some((c) => c.kind === 'query')).toBe(true);
    expect(chunks.some((c) => c.kind === 'table')).toBe(true);
    // Exhaustive: the corpus is exactly the canonical queries + table docs — nothing else. This
    // catches any re-added chunk source (traps under any id/kind included): indexing a trap would
    // only let retrieval duplicate what hardTraps() already puts in every prompt.
    expect(chunks).toHaveLength(CANONICAL_QUERIES.length + TABLES.length);
    expect(chunks.some((c) => c.id.startsWith('trap:'))).toBe(false);
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
  it('upserts one vector per chunk into the versioned native namespace, ids versioned too', async () => {
    const ai = fakeAI();
    const index = fakeIndex();
    const n = await indexSchemaCorpus(ai, index);
    expect(n).toBe(buildSchemaChunks().length);
    expect(index.upserted).toHaveLength(n);
    const first = index.upserted[0] as { id: string; namespace: string; metadata: { ns: string } };
    // Pin the literal, not SCHEMA_NS: a namespace bump must be a deliberate act that also updates
    // this test (and triggers a re-index) — never an accidental constant edit.
    expect(first.namespace).toBe('schema-v2');
    expect(first.metadata.ns).toBe('schema-v2');
    // Version in the id too: a re-index writes a NEW cohort instead of mutating the old one, so a
    // Worker rollback keeps querying the old cohort untouched.
    expect(first.id.startsWith('schema-v2:')).toBe(true);
  });
});

describe('retrieveSchemaContext', () => {
  it('returns the matched chunk texts and queries the versioned native namespace', async () => {
    const ai = fakeAI();
    const index = fakeIndex([
      {
        id: 'schema-v2:table:home_totals',
        score: 0.9,
        metadata: { kind: 'table', text: 'home_totals (глобални суми): contracts, value_eur, …' },
      },
    ]);
    expect(await retrieveSchemaContext(ai, index, 'обща сума')).toEqual([
      'home_totals (глобални суми): contracts, value_eur, …',
    ]);
    // Pin the NATIVE namespace and its literal value. The native namespace (not a metadata filter,
    // which would need a provisioned metadata index) is what keeps stale cohorts — e.g. pre-v2
    // `schema:trap:N` vectors — out of the topK entirely, so no trap can ever reach the prompt
    // twice and no topK slot is wasted on a discarded match. Also pins against a schema/entity mixup.
    expect(index.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ namespace: 'schema-v2' }),
    );
    expect(index.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ filter: expect.anything() }),
    );
  });

  it('drops matches below the relevance floor (so an off-topic top-K falls back to the full dictionary)', async () => {
    const ai = fakeAI();
    const index = fakeIndex([
      { id: 'schema:table:lots', score: 0.6, metadata: { text: 'релевантно' } },
      { id: 'schema:table:parties', score: 0.1, metadata: { text: 'нерелевантно' } },
    ]);
    // Only the above-floor chunk survives; the 0.1 match is discarded rather than injected as "context".
    expect(await retrieveSchemaContext(ai, index, 'въпрос')).toEqual(['релевантно']);
  });

  it('returns [] when every match is below the floor (buildSystemPrompt then uses the full dictionary)', async () => {
    const ai = fakeAI();
    const index = fakeIndex([{ id: 'schema:table:x', score: 0.05, metadata: { text: 'x' } }]);
    expect(await retrieveSchemaContext(ai, index, 'нищо общо')).toEqual([]);
  });

  it('drops a match that arrives with no score at all (defensive — safe full-dictionary fallback)', async () => {
    const ai = fakeAI();
    // Simulate an index backend that omits `score` on a match: it must read as below the floor (dropped),
    // not injected as unranked context. Cast because our typed contract promises a numeric score.
    const index = fakeIndex([
      { id: 'schema:table:x', metadata: { text: 'x' } } as unknown as Match,
    ]);
    expect(await retrieveSchemaContext(ai, index, 'въпрос')).toEqual([]);
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
