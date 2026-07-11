// RAG layer (Vectorize + Workers AI embeddings).
//
// WHY THIS EXISTS / DEVIATION FROM THE SPEC: the design in §1–§9 is a text→SQL tool-calling agent
// with NO vector retrieval. RAG is added here deliberately (per the implementation request) where it
// pays off most for a weak 27B model:
//
//   1. Schema/cookbook grounding (primary). Embed the data-dictionary trap-rules + canonical queries
//      (describe-schema.ts) and retrieve the few MOST RELEVANT chunks for the user's question, to
//      prepend to the system prompt. This is the retrieval-augmented form of spec §9 point 2 — the
//      single highest-leverage lever on SQL correctness — instead of dumping the whole dictionary.
//   2. Semantic corpus search (`semantic_search` tool). Embed entity/contract titles into Vectorize
//      so paraphrase/synonym queries ("детски градини" ~ "обединено детско заведение") match where
//      the FTS `search_entities` keyword tool misses. Complements, does not replace, FTS.
//
// Embedding model: @cf/baai/bge-m3 — multilingual (Bulgarian-capable), 1024-dim, runs on Workers AI.
//
// Bindings required at runtime (add to wrangler.jsonc; see assistant/README.md): `AI` (Workers AI)
// and `VECTORIZE` (a 1024-dim, cosine Vectorize index). Typed structurally below so this module is
// deploy-independent and unit-testable; `env.AI` / `env.VECTORIZE` satisfy these interfaces.

import { CANONICAL_QUERIES, DATA_TRAPS, TABLES } from './describe-schema';

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
  metadata?: Record<string, unknown>;
}
export interface VectorIndex {
  upsert(vectors: VectorRecord[]): Promise<unknown>;
  query(
    vector: number[],
    opts: {
      topK: number;
      returnMetadata?: boolean | 'all' | 'indexed';
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
export interface SchemaChunk {
  id: string;
  kind: 'trap' | 'query' | 'table';
  text: string;
}

export function buildSchemaChunks(): SchemaChunk[] {
  return [
    ...DATA_TRAPS.map((t, i) => ({ id: `trap:${i}`, kind: 'trap' as const, text: t })),
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

/** One-time / on-deploy: embed the schema chunks and upsert them into the `schema` namespace. */
export async function indexSchemaCorpus(ai: EmbeddingRunner, index: VectorIndex): Promise<number> {
  const chunks = buildSchemaChunks();
  const vectors = await embed(
    ai,
    chunks.map((c) => c.text),
  );
  await index.upsert(
    chunks.map((c, i) => ({
      id: `schema:${c.id}`,
      values: vectors[i]!,
      metadata: { ns: 'schema', kind: c.kind, text: c.text },
    })),
  );
  return chunks.length;
}

/** Retrieve the most relevant data-dictionary chunks for a question, to prepend to the prompt. */
export async function retrieveSchemaContext(
  ai: EmbeddingRunner,
  index: VectorIndex,
  question: string,
  topK = 6,
): Promise<string[]> {
  const [vec] = await embed(ai, [question]);
  if (!vec) return [];
  const { matches } = await index.query(vec, {
    topK,
    returnMetadata: 'all',
    filter: { ns: 'schema' },
  });
  return matches.map((m) => String(m.metadata?.text ?? '')).filter(Boolean);
}

// ── Semantic corpus search (the `semantic_search` tool) ─────────────────────────────────────────────

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
): Promise<SemanticHit[]> {
  const [vec] = await embed(ai, [query]);
  if (!vec) return [];
  const { matches } = await index.query(vec, {
    topK,
    returnMetadata: 'all',
    filter: { ns: 'entity' },
  });
  return matches.map((m) => ({
    kind: String(m.metadata?.kind ?? ''),
    ref: String(m.metadata?.ref ?? ''),
    title: String(m.metadata?.title ?? ''),
    score: m.score,
  }));
}
