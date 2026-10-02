import { describe, expect, it, vi } from 'vitest';
import { CANONICAL_QUERIES, TABLES } from './describe-schema';
import {
  buildSchemaChunks,
  embed,
  EMBED_DIM,
  ensureSchemaCorpus,
  indexSchemaCorpus,
  MAX_EMBED_CHARS,
  MIN_ENTITY_SCORE,
  MIN_SCHEMA_SCORE,
  retrieveSchemaContext,
  RETRY_INDEXING_AFTER_MS,
  SCHEMA_NS,
  schemaVectorId,
  semanticSearch,
  type EmbeddingRunner,
  type IndexingRun,
  type SemanticSearchStats,
  type RetrievalStats,
  type VectorIndex,
  type VectorRecord,
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
    getByIds: vi.fn(async () => []),
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
    // Version in the id too: a BUMPED re-index writes a NEW cohort next to the old one, so a
    // Worker rollback keeps querying the old cohort untouched (see the WHEN TO BUMP rule in rag.ts).
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
    // Exactly ONE query: toHaveBeenCalledWith alone would stay green if a second, filter-based
    // fallback query were ever added — the call count is what makes these assertions exhaustive.
    expect(index.query).toHaveBeenCalledTimes(1);
    expect(index.query).toHaveBeenCalledWith(
      expect.anything(),
      // returnMetadata:'all' is load-bearing, not a default: real Vectorize returns NO metadata
      // unless asked, and the fake hands back `metadata.text` regardless — so without this pin,
      // dropping the option stays green here while production keeps every chunk text-less (kept=0,
      // silent full-dictionary fallback on every turn).
      expect.objectContaining({ namespace: 'schema-v2', returnMetadata: 'all' }),
    );
    expect(index.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ filter: expect.anything() }),
    );
  });

  it('drops matches below the relevance floor (so an off-topic top-K falls back to the full dictionary)', async () => {
    const ai = fakeAI();
    // Derived from the floor (± epsilon), like every other floor fixture: a recalibration (#318)
    // above a hardcoded 0.6 would fail this test for a regression that does not exist.
    const index = fakeIndex([
      {
        id: 'schema-v2:table:lots',
        score: MIN_SCHEMA_SCORE + 0.05,
        metadata: { text: 'релевантно' },
      },
      {
        id: 'schema-v2:table:parties',
        score: MIN_SCHEMA_SCORE - 0.05,
        metadata: { text: 'нерелевантно' },
      },
    ]);
    // Only the above-floor chunk survives; the below-floor match is discarded rather than injected as "context".
    expect(await retrieveSchemaContext(ai, index, 'въпрос')).toEqual(['релевантно']);
  });

  it('returns [] when every match is below the floor (buildSystemPrompt then uses the full dictionary)', async () => {
    const ai = fakeAI();
    const index = fakeIndex([
      { id: 'schema-v2:table:x', score: MIN_SCHEMA_SCORE - 0.05, metadata: { text: 'x' } },
    ]);
    expect(await retrieveSchemaContext(ai, index, 'нищо общо')).toEqual([]);
  });

  it('reports matched/aboveFloor/kept through onStats (the #318 observability hook)', async () => {
    const ai = fakeAI();
    // Scores DERIVED from the floor (± epsilon), not hardcoded — the pending recalibration (#318)
    // must not silently flip this test's fixtures across the floor. The third match is above-floor
    // but text-less: kept < aboveFloor is the metadata-bug signal, distinct from a floor drop.
    const index = fakeIndex([
      {
        id: 'schema-v2:table:lots',
        score: MIN_SCHEMA_SCORE + 0.05,
        metadata: { text: 'релевантно' },
      },
      {
        id: 'schema-v2:table:parties',
        score: MIN_SCHEMA_SCORE - 0.05,
        metadata: { text: 'под флора' },
      },
      { id: 'schema-v2:table:bez-text', score: MIN_SCHEMA_SCORE + 0.05, metadata: {} },
    ]);
    const stats: RetrievalStats[] = [];
    const out = await retrieveSchemaContext(ai, index, 'въпрос', { onStats: (s) => stats.push(s) });
    expect(stats).toEqual([{ matched: 3, aboveFloor: 2, kept: 1 }]);
    // The counters must describe the actual return value, not a parallel computation.
    expect(out).toEqual(['релевантно']);
  });

  it('a throwing onStats sink never costs the turn its chunks (reporting is best-effort)', async () => {
    const ai = fakeAI();
    const index = fakeIndex([
      {
        id: 'schema-v2:table:lots',
        score: MIN_SCHEMA_SCORE + 0.05,
        metadata: { text: 'релевантно' },
      },
    ]);
    const out = await retrieveSchemaContext(ai, index, 'въпрос', {
      onStats: () => {
        throw new Error('metrics sink down');
      },
    });
    expect(out).toEqual(['релевантно']);
  });

  it('an ASYNC sink that rejects is defused too — no unhandled rejection escapes the turn', async () => {
    // `(stats) => void` accepts an async function; its rejection is not a sync throw, so the
    // try/catch alone would let it surface as an unhandled rejection (logged as an error by the
    // runtime — the opposite of best-effort).
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    // The web tsconfig carries Workers types, not Node's — reach the test runtime's process via globalThis.
    type Proc = {
      on(e: string, f: (r: unknown) => void): void;
      off(e: string, f: (r: unknown) => void): void;
    };
    const proc = (globalThis as unknown as { process: Proc }).process;
    proc.on('unhandledRejection', onUnhandled);
    try {
      const ai = fakeAI();
      const index = fakeIndex([
        { id: 'schema-v2:table:lots', score: MIN_SCHEMA_SCORE + 0.05, metadata: { text: 'x' } },
      ]);
      const out = await retrieveSchemaContext(ai, index, 'въпрос', {
        onStats: async () => {
          throw new Error('async sink down');
        },
      });
      const hits = await semanticSearch(ai, fakeIndex([]), 'нещо', {
        onStats: async () => {
          throw new Error('async entity sink down');
        },
      });
      await new Promise((r) => setTimeout(r, 0)); // let any stray rejection reach the handler
      expect(out).toEqual(['x']);
      expect(hits).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      proc.off('unhandledRejection', onUnhandled);
    }
  });

  it('reports zeros when embedding yields no query vector (no silent stats gap)', async () => {
    // A provider anomaly that survives embed()'s count check (right length, unusable vector)
    // takes the !vec early return — that path must still report, else this degradation is
    // indistinguishable in the logs from "stats not wired at all".
    const emptyAi = {
      run: vi.fn(async (_m: string, inputs: { text: string[] }) => ({
        data: inputs.text.map(() => undefined as unknown as number[]),
      })),
    } satisfies EmbeddingRunner;
    const index = fakeIndex([]);
    const stats: RetrievalStats[] = [];
    const out = await retrieveSchemaContext(emptyAi, index, 'въпрос', {
      onStats: (s) => stats.push(s),
    });
    expect(out).toEqual([]);
    expect(stats).toEqual([{ matched: 0, aboveFloor: 0, kept: 0 }]);
    expect(index.query).not.toHaveBeenCalled();
  });

  it('drops a match that arrives with no score at all (defensive — safe full-dictionary fallback)', async () => {
    const ai = fakeAI();
    // Simulate an index backend that omits `score` on a match: it must read as below the floor (dropped),
    // not injected as unranked context. Cast because our typed contract promises a numeric score.
    const index = fakeIndex([
      { id: 'schema-v2:table:x', metadata: { text: 'x' } } as unknown as Match,
    ]);
    expect(await retrieveSchemaContext(ai, index, 'въпрос')).toEqual([]);
  });
  it('drops a scoreless SCHEMA match even at an explicit minScore = 0 (symmetry with the entity path)', async () => {
    // `(undefined ?? 0) >= 0` would smuggle a scoreless match in as "context"; the safety must not
    // depend on the default floor happening to be > 0 (review f/u, ydimitrof).
    const ai = fakeAI();
    const index = fakeIndex([
      { id: 'schema-v2:table:x', metadata: { text: 'без score' } } as unknown as Match,
      { id: 'schema-v2:table:y', score: 0, metadata: { text: 'истинска нула' } },
    ]);
    expect(await retrieveSchemaContext(ai, index, 'въпрос', { topK: 6, minScore: 0 })).toEqual([
      'истинска нула',
    ]);
  });
});

describe('semanticSearch', () => {
  it('maps matches into hits and queries the versioned native entity namespace', async () => {
    const ai = fakeAI();
    const index = fakeIndex([
      { id: 'e1', score: 0.8, metadata: { kind: 'company', ref: 'eik:1', title: 'Фирма' } },
    ]);
    const out = await semanticSearch(ai, index, 'детски градини');
    expect(out[0]).toMatchObject({ kind: 'company', ref: 'eik:1', title: 'Фирма', score: 0.8 });
    // Pin the NATIVE namespace literal (a bump must be deliberate) and that no metadata filter is
    // used anywhere anymore — filters need a provisioned metadata index this repo does not have.
    // Exactly ONE query, so a filter-based retry/fallback path cannot sneak back in green.
    expect(index.query).toHaveBeenCalledTimes(1);
    expect(index.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ namespace: 'entity-v1', returnMetadata: 'all' }), // see the schema twin
    );
    expect(index.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ filter: expect.anything() }),
    );
  });

  it('drops matches below the relevance floor (off-topic neighbours never reach the model as hits)', async () => {
    const ai = fakeAI();
    // Scores derived from the floor (± epsilon), same discipline as the schema tests: a future
    // recalibration must not silently flip these fixtures across the floor.
    const index = fakeIndex([
      {
        id: 'e1',
        score: MIN_ENTITY_SCORE + 0.05,
        metadata: { kind: 'company', ref: 'eik:1', title: 'Фирма' },
      },
      {
        id: 'e2',
        score: MIN_ENTITY_SCORE - 0.05,
        metadata: { kind: 'company', ref: 'eik:2', title: 'Друга' },
      },
    ]);
    const out = await semanticSearch(ai, index, 'детски градини');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ref: 'eik:1' });
  });

  it('drops a scoreless match (reads as below the floor — same defensive rule as the schema path)', async () => {
    const ai = fakeAI();
    // A backend anomaly omitting `score` must not surface as an unranked "hit" (nor, later, as a
    // TypeError in tools.ts's score.toFixed) — below-floor is the safe reading.
    const index = fakeIndex([
      { id: 'e1', metadata: { kind: 'company', ref: 'eik:1', title: 'Фирма' } } as unknown as Match,
    ]);
    expect(await semanticSearch(ai, index, 'детски градини')).toEqual([]);
  });

  it('reports matched/kept through onStats (entity-side #318 symmetry, best-effort)', async () => {
    const ai = fakeAI();
    const index = fakeIndex([
      {
        id: 'e1',
        score: MIN_ENTITY_SCORE + 0.05,
        metadata: { kind: 'company', ref: 'eik:1', title: 'Фирма' },
      },
      {
        id: 'e2',
        score: MIN_ENTITY_SCORE - 0.05,
        metadata: { kind: 'company', ref: 'eik:2', title: 'Друга' },
      },
    ]);
    const stats: SemanticSearchStats[] = [];
    const out = await semanticSearch(ai, index, 'детски градини', {
      onStats: (s) => stats.push(s),
    });
    // kept must describe the actual return value; matched=0 would mean empty/unindexed namespace.
    expect(stats).toEqual([{ matched: 2, kept: 1 }]);
    expect(out).toHaveLength(1);
  });

  it('drops a scoreless match even with an explicit minScore = 0 (Number.isFinite, not ?? 0)', async () => {
    const ai = fakeAI();
    // The `?? 0` form would smuggle a scoreless match through a zero floor (0 >= 0): scoreless must
    // mean "dropped" for EVERY floor, while a genuine score of 0 stays a legitimate hit at floor 0.
    const index = fakeIndex([
      { id: 'e1', metadata: { kind: 'company', ref: 'eik:1', title: 'Фирма' } } as unknown as Match,
      { id: 'e2', score: 0, metadata: { kind: 'company', ref: 'eik:2', title: 'Друга' } },
    ]);
    const out = await semanticSearch(ai, index, 'детски градини', { topK: 8, minScore: 0 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ref: 'eik:2', score: 0 });
  });
});

describe('rag — embed mismatch and metadata mapping', () => {
  const runner = (data: unknown): EmbeddingRunner =>
    ({ run: async () => ({ data }) }) as unknown as EmbeddingRunner;
  const index = (
    matches: { id: string; score: number; metadata?: Record<string, unknown> }[],
  ): VectorIndex =>
    ({ upsert: async () => ({}), query: async () => ({ matches }) }) as unknown as VectorIndex;

  it('throws when the provider returns the wrong number of vectors', async () => {
    // 1 vector back for 2 input texts → the index-alignment invariant is violated.
    await expect(embed(runner([vec()]), ['a', 'b'])).rejects.toThrow(/expected 2 vectors/);
  });

  it('retrieveSchemaContext returns only non-empty chunk texts from the matches', async () => {
    const out = await retrieveSchemaContext(
      runner([vec()]),
      index([
        { id: '1', score: 0.9, metadata: { text: 'chunk A' } },
        { id: '2', score: 0.8, metadata: {} }, // no text → filtered out
      ]),
      'въпрос',
    );
    expect(out).toEqual(['chunk A']);
  });

  it('semanticSearch maps hit metadata, defaulting missing fields to empty strings', async () => {
    const hits = await semanticSearch(
      runner([vec()]),
      index([
        { id: 'e1', score: 0.7, metadata: { kind: 'company', ref: 'eik:1', title: 'Тест' } },
        { id: 'e2', score: 0.5 }, // no metadata → defaults
      ]),
      'заявка',
    );
    expect(hits[0]).toEqual({ kind: 'company', ref: 'eik:1', title: 'Тест', score: 0.7 });
    expect(hits[1]).toEqual({ kind: '', ref: '', title: '', score: 0.5 });
  });
});

describe('rag — provider-anomaly and empty-vector guards', () => {
  const runner = (data: unknown): EmbeddingRunner =>
    ({ run: async () => ({ data }) }) as unknown as EmbeddingRunner;
  const emptyIndex = () =>
    ({ upsert: async () => ({}), query: async () => ({ matches: [] }) }) as unknown as VectorIndex;

  it('embed reports "none" when the provider returns a non-array', async () => {
    await expect(embed(runner('nope'), ['a'])).rejects.toThrow(/got none/);
  });

  it('retrieveSchemaContext returns [] when the embedding vector is missing', async () => {
    expect(await retrieveSchemaContext(runner([undefined]), emptyIndex(), 'q')).toEqual([]);
  });

  it('semanticSearch returns [] when the embedding vector is missing', async () => {
    expect(await semanticSearch(runner([undefined]), emptyIndex(), 'q')).toEqual([]);
  });
});

describe('ensureSchemaCorpus (self-provisioning, #328 / the proof for #346)', () => {
  const chunks = buildSchemaChunks();
  const ids = chunks.map(schemaVectorId);
  type Read = { id: string; namespace?: string; metadata?: Record<string, unknown> };
  // What getByIds returns once this build's corpus is fully applied.
  const complete = (): Read[] =>
    chunks.map((c) => ({
      id: schemaVectorId(c),
      namespace: SCHEMA_NS,
      metadata: { text: c.text },
    }));
  function corpusIndex(found: Read[]) {
    return {
      upsert: vi.fn(async (_vectors: VectorRecord[]) => ({})),
      query: vi.fn(async () => ({ matches: [] })),
      getByIds: vi.fn(async () => found),
    } satisfies VectorIndex;
  }
  const fullStatus = (over: Partial<ReturnType<typeof status>> = {}) => ({ ...status(), ...over });
  const status = () => ({
    ns: SCHEMA_NS,
    expected: ids.length,
    present: ids.length,
    stale: 0,
    lean: 0,
    upserted: 0,
  });

  it('reports a complete corpus without touching the model or writing', async () => {
    const ai = fakeAI();
    const index = corpusIndex(complete());
    expect(await ensureSchemaCorpus(ai, index, { runs: new Map() })).toEqual(fullStatus());
    expect(index.getByIds).toHaveBeenCalledWith(ids);
    expect(ai.run).not.toHaveBeenCalled();
    expect(index.upsert).not.toHaveBeenCalled();
  });

  it('indexes a missing corpus, and at most ONCE per memo even while reads still lag', async () => {
    const ai = fakeAI();
    const index = corpusIndex([]);
    const runs = new Map<string, IndexingRun>();
    const first = await ensureSchemaCorpus(ai, index, { runs });
    expect(first).toEqual(fullStatus({ present: 0, upserted: ids.length }));
    expect(index.upsert).toHaveBeenCalledTimes(1);
    const written = index.upsert.mock.calls[0]?.[0] as unknown as VectorRecord[];
    expect(written.map((v) => v.id)).toEqual(ids);
    expect(written.every((v) => v.namespace === SCHEMA_NS)).toBe(true);
    // Vectorize applies writes asynchronously: a second call while getByIds still returns nothing
    // must report upserted 0 and NOT re-embed — that is the whole point of the memo.
    const second = await ensureSchemaCorpus(ai, index, { runs });
    expect(second.upserted).toBe(0);
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(index.upsert).toHaveBeenCalledTimes(1);
  });

  it("counts a vector against the corpus when its namespace or stored text is not this build's", async () => {
    const found = complete();
    found[0] = { ...found[0]!, namespace: 'schema-v1' }; // another cohort under a colliding id
    found[1] = { ...found[1]!, metadata: { text: 'стар текст' } }; // edited chunk, never re-indexed
    found.push({ id: 'schema-v2:query:999', namespace: SCHEMA_NS, metadata: { text: 'x' } }); // not asked
    // A foreign-namespace read that comes FIRST for an id wins the dedupe: the id is then counted as
    // missing (fail toward re-indexing), and a duplicate correct read later cannot flip it back.
    found.unshift({ ...found[2]!, namespace: 'schema-v1' });
    found.push({ ...found[4]! }); // an exact duplicate read is counted once
    const index = corpusIndex(found);
    const s = await ensureSchemaCorpus(fakeAI(), index, { runs: new Map() });
    expect(s).toEqual(fullStatus({ present: ids.length - 3, stale: 1, upserted: ids.length }));
    expect(index.upsert).toHaveBeenCalledTimes(1);
  });

  it('degrades to id presence when a lean read carries no namespace or metadata — and says so via `lean`', async () => {
    const index = corpusIndex(ids.map((id) => ({ id })));
    const s = await ensureSchemaCorpus(fakeAI(), index, { runs: new Map() });
    expect(s).toEqual(fullStatus({ lean: ids.length }));
    expect(index.upsert).not.toHaveBeenCalled();
  });

  it('retries a RESOLVED run once its retry window has passed, but not before', async () => {
    // A run Vectorize accepted but never applied would otherwise answer `upserted: 0` for the life of
    // the isolate; after RETRY_INDEXING_AFTER_MS the memo expires and one fresh run is allowed.
    const ai = fakeAI();
    const index = corpusIndex([]);
    const runs = new Map<string, IndexingRun>();
    let clock = 1_000_000;
    const now = () => clock;
    expect((await ensureSchemaCorpus(ai, index, { runs, now })).upserted).toBe(ids.length);
    clock += RETRY_INDEXING_AFTER_MS - 1;
    expect((await ensureSchemaCorpus(ai, index, { runs, now })).upserted).toBe(0);
    expect(ai.run).toHaveBeenCalledTimes(1);
    clock += 2;
    expect((await ensureSchemaCorpus(ai, index, { runs, now })).upserted).toBe(ids.length);
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it('forgets a FAILED indexing run so the next call retries instead of replaying the failure', async () => {
    const runs = new Map<string, IndexingRun>();
    const index = corpusIndex([]);
    let calls = 0;
    const ai = {
      run: vi.fn(async (_model: string, inputs: { text: string[] }) => {
        calls += 1;
        if (calls === 1) throw new Error('провайдърът падна');
        return { data: inputs.text.map(vec) };
      }),
    } satisfies EmbeddingRunner;
    await expect(ensureSchemaCorpus(ai, index, { runs })).rejects.toThrow('провайдърът падна');
    expect(runs.size).toBe(0);
    const s = await ensureSchemaCorpus(ai, index, { runs });
    expect(s.upserted).toBe(ids.length);
    expect(index.upsert).toHaveBeenCalledTimes(1);
  });
});
