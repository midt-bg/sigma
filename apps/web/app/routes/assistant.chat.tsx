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
import { resolveRowsReadBudget, type ToolContext } from '../lib/assistant/tools';
import { selectClientMessages } from '../lib/assistant/chat-input';
import { firstPartyRejection } from '../lib/assistant/request-guard';

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
const MAX_MESSAGE_CHARS = 64 * 1024; // per-message text cap — one giant message must not dominate the prompt

/** Total length of a message's text parts (the only parts that become BgGPT prompt tokens). */
function messageTextChars(m: UIMessage): number {
  return m.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .reduce((n, p) => n + p.text.length, 0);
}

export async function action({ request, context }: Route.ActionArgs) {
  // First-party guard BEFORE buffering the body: a cross-site page must not be able to start a paid BgGPT
  // turn from a victim's browser (CSRF → denial-of-wallet). Requiring application/json forces a preflight
  // on any cross-origin fetch (never green-lit) and blocks <form> CSRF (review #80, lyubomir-bozhinov).
  const rejection = firstPartyRejection({
    method: request.method,
    contentType: request.headers.get('Content-Type'),
    secFetchSite: request.headers.get('Sec-Fetch-Site'),
  });
  if (rejection) return Response.json({ error: rejection.error }, { status: rejection.status });

  // Reject an over-cap body by its DECLARED Content-Length before buffering it into Worker memory; the
  // post-read UTF-8 check below is the fallback for an absent/under-stated header (review #80, ydimitrof).
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return Response.json({ error: 'историята е твърде голяма' }, { status: 413 });
  }

  const raw = await request.text();
  // Measure UTF-8 bytes, not raw.length (UTF-16 code units): a Cyrillic-heavy body is ~2 UTF-8 bytes per
  // char, so raw.length would pass at ~2× the intended cap (same pitfall fixed in eop-fetch.ts, review #80).
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return Response.json({ error: 'историята е твърде голяма' }, { status: 413 });
  }
  let parsed: { messages?: UIMessage[] };
  try {
    parsed = JSON.parse(raw) as { messages?: UIMessage[] };
  } catch {
    return Response.json({ error: 'невалиден JSON' }, { status: 400 });
  }
  // Keep only the user/assistant turns the dock sends, most-recent first — drops any client-supplied
  // `system`/`tool` message that would otherwise reach BgGPT as a second system instruction (review #80,
  // red-team R1). See selectClientMessages for why filtering precedes the recency slice.
  const messages = selectClientMessages(parsed.messages, MAX_MESSAGES);
  if (messages.length === 0) return Response.json({ error: 'няма съобщения' }, { status: 400 });
  // The total body cap leaves room for ONE message to dominate (re-billed as prompt tokens every step);
  // reject an oversized individual message too (review #80).
  if (messages.some((m) => messageTextChars(m) > MAX_MESSAGE_CHARS)) {
    return Response.json({ error: 'съобщението е твърде дълго' }, { status: 413 });
  }

  const env = context.cloudflare.env;
  // Fail fast and CLEARLY if the model key is unprovisioned, rather than starting a turn that surfaces a
  // generic mid-stream BgGPT 401 indistinguishable from a real outage (review #80).
  if (!(env as unknown as AgentEnv).BGGPT_API_KEY) {
    console.error('[assistant] BGGPT_API_KEY is not set — endpoint not provisioned');
    return Response.json({ error: 'Асистентът все още не е конфигуриран.' }, { status: 503 });
  }
  const ai = env.AI as unknown as EmbeddingRunner | undefined;
  const vectorize = env.VECTORIZE as unknown as VectorIndex | undefined;
  // The latest user message text — used both to RAG-ground the prompt and as the server-authoritative
  // report question, so the model's echo can never smuggle an unbound number into the question slot
  // (review #80).
  const question = latestUserText(messages);
  const ctx: ToolContext = {
    db: env.DB,
    ai,
    vectorize,
    results: [],
    userQuestion: question,
    // Per-turn Denial-of-Wallet guard (issue #122): bound the D1 rows-read cost of this turn's run_sql
    // calls. `LIMIT` caps only returned rows; D1 bills on rows scanned.
    rowsRead: 0,
    rowsReadBudget: resolveRowsReadBudget(env.D1_ROWS_READ_BUDGET),
  };

  // RAG grounding (best-effort): the most relevant schema chunks for the latest question; on any
  // failure the system prompt falls back to the full static dictionary.
  let schemaContext: string[] | undefined;
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
