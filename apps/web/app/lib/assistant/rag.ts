// RAG layer (Vectorize + Workers AI embeddings).
//
// WHY THIS EXISTS / DEVIATION FROM THE SPEC: the design in §1–§9 is a text→SQL tool-calling agent
// with NO vector retrieval. RAG is added here deliberately (per the implementation request) where it
// pays off most for a weak 27B model:
//
//   1. Schema/cookbook grounding (primary). Embed the data-dictionary canonical queries + table docs
//      (describe-schema.ts) and retrieve the few MOST RELEVANT chunks for the user's question, to
//      prepend to the system prompt. This is the retrieval-augmented form of spec §9 point 2 — the
//      single highest-leverage lever on SQL correctness — instead of dumping the whole dictionary.
//      (The imperative DATA_TRAPS are NOT part of this corpus — they enter every prompt
//      unconditionally via hardTraps(), system-prompt.ts.)
//   2. Semantic corpus search (`semantic_search` tool). Embed entity/contract titles into Vectorize
//      so paraphrase/synonym queries ("детски градини" ~ "обединено детско заведение") match where
//      keyword search misses. Intended to COMPLEMENT keyword/FTS lookup, not replace it — note the
//      spec's `search_entities` FTS tool is NOT implemented yet, and the entity corpus itself is
//      still unindexed (see README "Какво остава"): today this tool returns 0 hits by design.
//
// Embedding model: @cf/baai/bge-m3 — multilingual (Bulgarian-capable), 1024-dim, runs on Workers AI.
//
// Bindings required at runtime (add to wrangler.jsonc; see assistant/README.md): `AI` (Workers AI)
// and `VECTORIZE` (a 1024-dim, cosine Vectorize index). Typed structurally below so this module is
// deploy-independent and unit-testable. NB: the structural types are a deliberately NARROWED view of
// the real bindings, not assignability-checked against them — the route casts (`as unknown as`,
// assistant.chat.tsx), so changes here must be verified by eye against worker-configuration.d.ts
// (VectorizeIndex / VectorizeQueryOptions); tsc will not catch a drift through that cast.

import { CANONICAL_QUERIES, TABLES } from './describe-schema';

export const EMBED_MODEL = '@cf/baai/bge-m3';
export const EMBED_DIM = 1024;
// Cap per-text length before embedding — a paraphrase query is short; this bounds an oversized
// model/user string (review #80).
export const MAX_EMBED_CHARS = 2048;

export interface EmbeddingRunner {
  run(model: string, inputs: { text: string[] }): Promise<{ data: number[][] }>;
}
export interface VectorRecord {
  id: string;
  values: number[];
  namespace?: string;
  metadata?: Record<string, unknown>;
}
export interface VectorIndex {
  upsert(vectors: VectorRecord[]): Promise<unknown>;
  query(
    vector: number[],
    opts: {
      topK: number;
      returnMetadata?: boolean | 'all' | 'indexed';
      namespace?: string;
      filter?: Record<string, unknown>;
    },
  ): Promise<{ matches: { id: string; score: number; metadata?: Record<string, unknown> }[] }>;
}

export async function embed(ai: EmbeddingRunner, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const capped = texts.map((t) => (t.length > MAX_EMBED_CHARS ? t.slice(0, MAX_EMBED_CHARS) : t));
  const { data } = await ai.run(EMBED_MODEL, { text: capped });
  // Fail fast on a provider anomaly: indexSchemaCorpus/retrieve align vectors[i]↔chunks[i] by index,
  // so a count mismatch would silently misattribute embeddings (review #80).
  if (!Array.isArray(data) || data.length !== capped.length) {
    throw new Error(
      `embed: expected ${capped.length} vectors, got ${Array.isArray(data) ? data.length : 'none'}`,
    );
  }
  return data;
}

// ── Schema/cookbook grounding ─────────────────────────────────────────────────────────────────────

// Stable chunks from the data dictionary. `text` is what gets embedded + retrieved into the prompt.
// DATA_TRAPS are deliberately NOT indexed: buildSystemPrompt injects every trap unconditionally
// (hardTraps(), system-prompt.ts), so a retrieved trap chunk could only ever duplicate prompt text —
// retrieval's job is picking the tables/example-queries relevant to the question (review, ydimitrof).
export interface SchemaChunk {
  id: string;
  kind: 'query' | 'table';
  text: string;
}

export function buildSchemaChunks(): SchemaChunk[] {
  return [
    ...CANONICAL_QUERIES.map((q, i) => ({
      id: `query:${i}`,
      kind: 'query' as const,
      text: `${q.intent}\n${q.sql}`,
    })),
    ...TABLES.map((t) => ({
      id: `table:${t.name}`,
      kind: 'table' as const,
      text: `${t.name} (${t.grain}): ${t.columns}`,
    })),
  ];
}

// Versioned NATIVE Vectorize namespace for the schema corpus. Why this shape:
//   - Native namespaces work without a metadata index and are applied before any metadata filter,
//     so vectors from an older corpus generation (e.g. pre-v2 `schema:trap:N`) can NEVER reach
//     retrieval — no per-query filtering, no topK slots wasted on stale matches.
//   - The version is in the vector ids too, so a BUMPED re-index writes a NEW cohort next to the
//     old one: rolling the Worker back to a previous release keeps working against the old cohort.
//   - An environment that has not (re-)indexed yet returns zero matches, and buildSystemPrompt
//     falls back to the full static dictionary — the module's documented safe outcome.
// WHEN TO BUMP (then re-run indexSchemaCorpus): any corpus change that removes, reorders, or
// re-purposes chunk ids. Within a version, upsert mutates ids IN PLACE and never deletes — a
// removal would leave an orphan vector forever eligible for topK, and `query:${i}` ids are
// positional, so a mid-array insert re-points every later id at different content. Pure appends
// and in-place refinements of an existing chunk's text are safe without a bump.
export const SCHEMA_NS = 'schema-v2';

/** On provisioning / after a SCHEMA_NS bump: embed the schema chunks and upsert them into SCHEMA_NS. */
export async function indexSchemaCorpus(ai: EmbeddingRunner, index: VectorIndex): Promise<number> {
  const chunks = buildSchemaChunks();
  const vectors = await embed(
    ai,
    chunks.map((c) => c.text),
  );
  await index.upsert(
    chunks.map((c, i) => ({
      id: `${SCHEMA_NS}:${c.id}`,
      values: vectors[i]!,
      namespace: SCHEMA_NS,
      // `ns` in metadata is FORENSIC only (wrangler vectorize get / debugging which cohort a
      // vector belongs to). It is NOT filterable — no metadata index exists (#317); all scoping
      // goes through the native `namespace` above. Do not re-arm metadata filtering on it.
      metadata: { ns: SCHEMA_NS, kind: c.kind, text: c.text },
    })),
  );
  return chunks.length;
}

// Cosine-similarity floor for a schema match to count as "relevant". Without it, top-K always returns
// its K least-distant chunks even when ALL are off-topic, and buildSystemPrompt would then use those
// few chunks INSTEAD of the full dictionary — i.e. partial grounding strictly weaker than the no-RAG
// fallback. Below the floor we return fewer (or zero) chunks; zero makes buildSystemPrompt fall back to
// the full static dictionary, which is the safe outcome. bge-m3 cosine puts genuinely relevant chunks
// well above this; the value is deliberately conservative (review follow-up).
export const MIN_SCHEMA_SCORE = 0.35;

/** Retrieve the most relevant data-dictionary chunks for a question, to prepend to the prompt. */
export async function retrieveSchemaContext(
  ai: EmbeddingRunner,
  index: VectorIndex,
  question: string,
  topK = 6,
  minScore = MIN_SCHEMA_SCORE,
): Promise<string[]> {
  const [vec] = await embed(ai, [question]);
  if (!vec) return [];
  // Native namespace, not a metadata filter: it needs no metadata index and excludes every vector
  // outside SCHEMA_NS at the source — stale cohorts (e.g. pre-v2 trap chunks) cannot occupy topK
  // slots, so retrieval always ranks topK eligible chunks.
  const { matches } = await index.query(vec, {
    topK,
    returnMetadata: 'all',
    namespace: SCHEMA_NS,
  });
  return (
    matches
      // Keep only matches at/above the relevance floor. `?? 0` is defensive, not decorative: our typed
      // contract promises a numeric `score`, but if an index backend ever omits it, a scoreless match must
      // read as below the floor (dropped) — never injected as unranked "context". Zero survivors makes
      // buildSystemPrompt fall back to the full static dictionary, which is the safe outcome (review, ydimitrof).
      .filter((m) => (m.score ?? 0) >= minScore)
      .map((m) => String(m.metadata?.text ?? ''))
      .filter(Boolean)
  );
}

// ── Semantic corpus search (the `semantic_search` tool) ─────────────────────────────────────────────

// Versioned NATIVE Vectorize namespace for the entity corpus — it removes the module's last
// metadata `filter`, which Vectorize only honours on properties with a provisioned metadata index
// (none exists in this repo — issue #317). No entity vectors have ever been indexed (the entity
// indexer is a "Какво остава" item), so there is no legacy cohort to migrate: the future indexer
// must upsert with `namespace: ENTITY_NS`. NB for that indexer: the SCHEMA_NS "WHEN TO BUMP" rule
// does NOT transfer — it assumes a hand-authored, append-only, code-resident corpus. The entity
// corpus is DATA-DERIVED: entities genuinely disappear (dedup, re-attribution, quarantine), so the
// indexer needs a real reconciliation/delete path of its own (and must track its ids — Vectorize
// deletes only by explicit id list); versioning alone would force a full re-embed per removal.
export const ENTITY_NS = 'entity-v1';

// Relevance floor for an entity match — symmetric with MIN_SCHEMA_SCORE (see its rationale): once
// the entity corpus is populated, top-K always returns its K least-distant neighbours EVEN when all
// are off-topic, and without a floor they would reach the model as real "hits" (tools.ts renders
// them with score.toFixed). Zero survivors is the honest outcome for an off-topic query. Scoreless
// matches read as below the floor (dropped) — the same defensive rule as the schema path.
// (review f/u on #319, ydimitrof)
export const MIN_ENTITY_SCORE = 0.35;

export interface SemanticHit {
  kind: string;
  ref: string;
  title: string;
  score: number;
}

/** Vector search over indexed entity/contract titles — complements the FTS keyword tool. */
export async function semanticSearch(
  ai: EmbeddingRunner,
  index: VectorIndex,
  query: string,
  topK = 8,
  minScore = MIN_ENTITY_SCORE,
): Promise<SemanticHit[]> {
  const [vec] = await embed(ai, [query]);
  if (!vec) return [];
  const { matches } = await index.query(vec, {
    topK,
    returnMetadata: 'all',
    namespace: ENTITY_NS,
  });
  return matches
    .filter((m) => (m.score ?? 0) >= minScore)
    .map((m) => ({
      kind: String(m.metadata?.kind ?? ''),
      ref: String(m.metadata?.ref ?? ''),
      title: String(m.metadata?.title ?? ''),
      // The floor guarantees a numeric score here for any minScore > 0; `?? 0` keeps the DTO total
      // (score stays a number, never a TypeError in tools.ts) even if a caller passes minScore = 0.
      score: m.score ?? 0,
    }));
}
