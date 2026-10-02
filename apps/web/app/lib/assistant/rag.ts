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
// deploy-independent and unit-testable. Two different contracts, per interface (issue #316):
//   - VectorIndex is a NARROWED view of VectorizeIndex kept structurally ASSIGNABLE from it — the
//     route binds `env.VECTORIZE` with no cast, so tsc proves the contract. Keep it assignable: a
//     member typed too loosely breaks that proof (the old `filter?: Record<string, unknown>` did —
//     Vectorize's own filter type is the stricter VectorizeVectorMetadataFilter, and filtering
//     additionally needs a provisioned metadata index, which this repo does not create).
//   - EmbeddingRunner is NOT assignable from `Ai` (its run() is generic per-model and returns an
//     output UNION); the one sanctioned bridge is embeddingRunnerFor() in bindings.ts, which calls
//     the real @cf/baai/bge-m3 overload — also compiler-checked. Never bridge with `as unknown as`.

import { CANONICAL_QUERIES, TABLES } from './describe-schema';

export const EMBED_MODEL = '@cf/baai/bge-m3';
export const EMBED_DIM = 1024;
// Cap per-text length before embedding — a paraphrase query is short; this bounds an oversized
// model/user string (review #80).
export const MAX_EMBED_CHARS = 2048;

export interface EmbeddingRunner {
  // `model` is the EMBED_MODEL literal, not string: the production adapter (bindings.ts) forwards
  // it into the per-model-typed Ai.run overload, so a second, different-model call added here
  // would be a compile error instead of silently embedding with the wrong model.
  run(model: typeof EMBED_MODEL, inputs: { text: string[] }): Promise<{ data: number[][] }>;
}
// The metadata values Vectorize accepts (mirrors VectorizeVectorMetadataValue). Typed narrowly on
// the WRITE side so VectorRecord[] stays assignable to VectorizeVector[] — that assignability is
// what lets the route bind `env.VECTORIZE` without a cast (issue #316). Reads stay `unknown`:
// consuming code must not trust index contents structurally.
export type VectorMetadataValue = string | number | boolean | string[];

export interface VectorRecord {
  id: string;
  values: number[];
  namespace?: string;
  metadata?: Record<string, VectorMetadataValue>;
}
export interface VectorIndex {
  upsert(vectors: VectorRecord[]): Promise<unknown>;
  query(
    vector: number[],
    opts: {
      topK: number;
      returnMetadata?: boolean | 'all' | 'indexed';
      namespace?: string;
    },
  ): Promise<{ matches: { id: string; score: number; metadata?: Record<string, unknown> }[] }>;
}

export async function embed(ai: EmbeddingRunner, texts: string[]): Promise<number[][]> {
  // This early return IS the adapter's contract: embeddingRunnerFor() (bindings.ts) reads an empty
  // `data` array as a provider fault ("empty batch for a NON-empty input") and never expects to be
  // called with zero texts. Keep it above the run() so the contract holds for EVERY caller, not just
  // today's three (review f/u, ydimitrof) — rag.test.ts pins that the model is not called for [].
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
// and in-place refinements of an existing chunk's text need no bump — but they STILL need a re-run
// of indexSchemaCorpus: retrieval returns the `metadata.text` stored at index time, never the
// current TABLES/CANONICAL_QUERIES source, so an un-indexed edit ships stale prompt text.
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
// RECALIBRATION PENDING (issue #318): this value was tuned against the pre-v2 corpus, where 12 of
// ~37 chunks were short imperative traps. The v2 corpus is 25 longer-form query/table chunks that
// score differently under bge-m3 — measure real question scores (RetrievalStats makes the fallback
// rate observable) before trusting the floor in the new regime.
export const MIN_SCHEMA_SCORE = 0.35;

// What retrieval saw for one question — the observability hook for issue #318. Three counters so
// the two distinct failure classes stay distinguishable (they have opposite fixes):
//   matched    — the index's raw namespace-scoped matches (0 = empty/unindexed namespace, or an
//                embed that produced no query vector; both report zeros rather than staying silent);
//   aboveFloor — matches at/above MIN_SCHEMA_SCORE (matched > aboveFloor = the floor is dropping);
//   kept       — chunks that actually reached the prompt (aboveFloor > kept = matches carried
//                missing/empty `metadata.text`, i.e. a write→read metadata bug, NOT a floor issue).
// kept=0 with matched>0 is the silent full-dictionary fallback the counters exist to expose.
export interface RetrievalStats {
  matched: number;
  aboveFloor: number;
  kept: number;
}

export interface RetrieveOptions {
  topK?: number;
  minScore?: number;
  // Called once per retrieval with the match counters. A callback, not a changed return shape, so
  // the report is optional and the function's contract stays a plain chunk list. Reporting must
  // never affect the served result: the callback is invoked inside its own try/catch (same
  // invariant as workers/request-log.ts) — a throwing stats sink cannot cost the turn its chunks.
  onStats?: (stats: RetrievalStats) => void;
}

function reportStats<S>(onStats: ((stats: S) => void) | undefined, stats: S): void {
  try {
    // Called synchronously (a sync throw lands in the catch), and a returned promise is defused too:
    // `=> void` accepts an async sink, whose rejection would otherwise escape as an unhandled
    // rejection — logged as an error by the runtime, the opposite of "best-effort".
    const r: unknown = onStats?.(stats);
    if (r && typeof (r as { then?: unknown }).then === 'function') {
      (r as Promise<unknown>).catch(() => {});
    }
  } catch {
    // Observability is best-effort by contract — never let it degrade retrieval.
  }
}

/** Retrieve the most relevant data-dictionary chunks for a question, to prepend to the prompt. */
export async function retrieveSchemaContext(
  ai: EmbeddingRunner,
  index: VectorIndex,
  question: string,
  opts: RetrieveOptions = {},
): Promise<string[]> {
  const { topK = 6, minScore = MIN_SCHEMA_SCORE, onStats } = opts;
  const [vec] = await embed(ai, [question]);
  if (!vec) {
    // No query vector (embed produced nothing usable): still report, as zeros — a silent branch
    // here would make this degradation indistinguishable from "stats not wired" (issue #318).
    reportStats(onStats, { matched: 0, aboveFloor: 0, kept: 0 });
    return [];
  }
  // Native namespace, not a metadata filter: it needs no metadata index and excludes every vector
  // outside SCHEMA_NS at the source — stale cohorts (e.g. pre-v2 trap chunks) cannot occupy topK
  // slots, so retrieval always ranks topK eligible chunks.
  const { matches } = await index.query(vec, {
    topK,
    returnMetadata: 'all',
    namespace: SCHEMA_NS,
  });
  // Keep only matches at/above the relevance floor. Number.isFinite, not `?? 0`: our typed contract
  // promises a numeric `score`, but if an index backend ever omits it, a scoreless match must read
  // as below the floor for EVERY minScore — including an explicit 0, where `(undefined ?? 0) >= 0`
  // would smuggle it through as unranked "context". Zero survivors makes buildSystemPrompt fall back
  // to the full static dictionary, which is the safe outcome (review f/u, ydimitrof).
  const aboveFloor = matches.filter((m) => Number.isFinite(m.score) && m.score >= minScore);
  const kept = aboveFloor.map((m) => String(m.metadata?.text ?? '')).filter(Boolean);
  reportStats(onStats, {
    matched: matches.length,
    aboveFloor: aboveFloor.length,
    kept: kept.length,
  });
  return kept;
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

// Observability counters for one semantic_search call — the entity-side sibling of RetrievalStats
// (issue #318): matched = raw namespace-scoped matches (0 = empty/unindexed `entity-v1`), kept =
// hits above the relevance floor that reached the model. There is no third counter: unlike the
// schema path, hits carry no extracted text stage that could drop them. Without these, "floor
// dropped everything" and "empty namespace" are operationally indistinguishable once the entity
// indexer (Фаза 2) populates the corpus.
export interface SemanticSearchStats {
  matched: number;
  kept: number;
}

// Mirror of RetrieveOptions — the same contract in the same shape, so a caller that only wants
// stats does not have to pass `undefined, undefined, cb` positionally.
export interface SemanticSearchOptions {
  topK?: number;
  minScore?: number;
  // Same best-effort contract as RetrieveOptions.onStats: invoked in reportStats' try/catch, so a
  // throwing sink can never cost the tool its hits.
  onStats?: (stats: SemanticSearchStats) => void;
}

/** Vector search over indexed entity/contract titles — complements the FTS keyword tool. */
export async function semanticSearch(
  ai: EmbeddingRunner,
  index: VectorIndex,
  query: string,
  opts: SemanticSearchOptions = {},
): Promise<SemanticHit[]> {
  const { topK = 8, minScore = MIN_ENTITY_SCORE, onStats } = opts;
  const [vec] = await embed(ai, [query]);
  if (!vec) {
    reportStats(onStats, { matched: 0, kept: 0 });
    return [];
  }
  const { matches } = await index.query(vec, {
    topK,
    returnMetadata: 'all',
    namespace: ENTITY_NS,
  });
  const hits = matches
    // Number.isFinite, not `?? 0`: a scoreless match must be dropped for EVERY minScore, including
    // an explicit 0 (where `(undefined ?? 0) >= 0` would smuggle it through as a "hit"). After this
    // filter the score is a real number, so the DTO below needs no fallback (review f/u, ydimitrof).
    .filter((m) => Number.isFinite(m.score) && m.score >= minScore)
    .map((m) => ({
      kind: String(m.metadata?.kind ?? ''),
      ref: String(m.metadata?.ref ?? ''),
      title: String(m.metadata?.title ?? ''),
      score: m.score,
    }));
  reportStats(onStats, { matched: matches.length, kept: hits.length });
  return hits;
}
