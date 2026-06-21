// Resource route: the assistant chat endpoint. The dock POSTs the UIMessage history; we run one
// agent turn (BgGPT via the AI Gateway + the read-only tool loop) and stream the result back. The
// server is stateless (spec §5) — nothing per-user is persisted here.

import type { UIMessage } from 'ai';
import type { Route } from './+types/assistant.chat';
import { runAssistant, type AgentEnv } from '../lib/assistant/agent';
import {
  retrieveSchemaContext,
  type EmbeddingRunner,
  type VectorIndex,
} from '../lib/assistant/rag';
import type { ToolContext } from '../lib/assistant/tools';

function latestUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    return m.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join(' ')
      .trim();
  }
  return '';
}

const MAX_BODY_BYTES = 256 * 1024; // ~256 KB of posted history — bounds memory + token blow-up (review #80)
const MAX_MESSAGES = 24; // keep only the most recent turns (the model has a big window; still bound it)

export async function action({ request, context }: Route.ActionArgs) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json({ error: 'историята е твърде голяма' }, { status: 413 });
  }
  let parsed: { messages?: UIMessage[] };
  try {
    parsed = JSON.parse(raw) as { messages?: UIMessage[] };
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const messages = (parsed.messages ?? []).slice(-MAX_MESSAGES); // most recent turns only
  if (messages.length === 0) return Response.json({ error: 'no messages' }, { status: 400 });

  const env = context.cloudflare.env;
  const ai = env.AI as unknown as EmbeddingRunner | undefined;
  const vectorize = env.VECTORIZE as unknown as VectorIndex | undefined;
  const ctx: ToolContext = { db: env.DB, ai, vectorize, results: [] };

  // RAG grounding (best-effort): the most relevant schema chunks for the latest question; on any
  // failure the system prompt falls back to the full static dictionary.
  let schemaContext: string[] | undefined;
  const question = latestUserText(messages);
  if (ai && vectorize && question) {
    try {
      schemaContext = await retrieveSchemaContext(ai, vectorize, question);
    } catch {
      schemaContext = undefined;
    }
  }

  try {
    return await runAssistant({
      env: env as unknown as AgentEnv,
      ctx,
      messages,
      schemaContext,
      abortSignal: request.signal,
    });
  } catch (error) {
    // Setup-time failure (missing key, bad config, malformed history) — degrade to a readable 503
    // rather than an unhandled 500. Mid-stream BgGPT errors are handled by the stream's onError.
    console.error('[assistant] turn failed to start', error);
    return Response.json(
      { error: 'Асистентът временно не е достъпен. Опитай отново след малко.' },
      { status: 503 },
    );
  }
}
