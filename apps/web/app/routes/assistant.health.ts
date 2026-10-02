// Resource route: GET /assistant/health — the proof, for CD (#346), that the assistant's schema corpus
// is indexed in THIS environment, and the trigger for the Worker to provision it itself (#328). The
// body is counters only (CorpusStatus): never a chunk text, never a provider message. 200 only when
// every expected vector is readable in SCHEMA_NS with this build's text; 503 otherwise — so a `curl -f`
// probe fails — with the same counters, so an operator can tell "empty" from "half-applied". Vectorize
// applies writes asynchronously: the call that provisions answers 503 with upserted>0, and a re-read a
// little later answers 200 (the deploy step retries for that reason). Cheap by construction — one point
// read, and one indexing run per isolate at most — and throttled like the chat route
// (workers/assistant-rate-limit.ts). No user input reaches it.

import type { Route } from './+types/assistant.health';
import { embeddingRunnerFor } from '../lib/assistant/bindings';
import { errorText } from '../lib/assistant/log-safety';
import {
  ensureSchemaCorpus,
  type CorpusStatus,
  type EmbeddingRunner,
  type VectorIndex,
} from '../lib/assistant/rag';

// A health answer must never come from a cache: the point is the CURRENT index state.
const headers = { 'Cache-Control': 'no-store' };

export async function loader({ context }: Route.LoaderArgs) {
  const env = context.cloudflare.env;
  // Same typed bindings as the chat route (issue #316): VECTORIZE assigned structurally, AI through the
  // one sanctioned bridge.
  const vectorize: VectorIndex | undefined = env.VECTORIZE;
  const ai: EmbeddingRunner | undefined = env.AI ? embeddingRunnerFor(env.AI) : undefined;
  if (!ai || !vectorize) {
    return Response.json({ error: 'unprovisioned' }, { status: 503, headers });
  }
  let status: CorpusStatus;
  try {
    status = await ensureSchemaCorpus(ai, vectorize);
  } catch (error) {
    // Message only, bounded, never the raw object (log-safety.ts); no user text exists here to redact.
    console.error(`[assistant] corpus check failed: ${errorText(error)}`);
    return Response.json({ error: 'unavailable' }, { status: 503, headers });
  }
  // Structured, counts only — the same discipline as the per-turn stats line (issue #318).
  console.log(JSON.stringify({ evt: 'assistant.index', ...status }));
  return Response.json(status, {
    status: status.present === status.expected ? 200 : 503,
    headers,
  });
}
