// Resource route: one-shot schema-corpus seed for the assistant's RAG grounding. POST re-embeds the
// static data dictionary (describe-schema.ts) into the Vectorize `sigma-assistant` index via
// indexSchemaCorpus. Run ONCE per environment after the index is provisioned (see
// app/lib/assistant/README.md → „Provisioning gate"). Idempotent: indexSchemaCorpus upserts by stable
// id, so re-running refreshes the corpus in place rather than duplicating it.
//
// Gated by ASSISTANT_SEED_TOKEN and OFF by default — when the token is unset the route 404s, identical
// to a non-existent path (no provisioning signal). The seed itself spends Workers AI embedding calls,
// so the token is the gate; there is no per-IP limiter here (an unauthorized caller only ever reaches
// the cheap 404/403 above the expensive embed).

import type { Route } from './+types/assistant.reindex';
import {
  gatewayRunner,
  indexSchemaCorpus,
  type EmbeddingRunner,
  type VectorIndex,
} from '../lib/assistant/rag';
import { authorizeSeed, bearerToken } from '../lib/assistant/seed-endpoint';

interface ReindexEnv {
  ASSISTANT_SEED_TOKEN?: string;
  AI?: EmbeddingRunner;
  VECTORIZE?: VectorIndex;
  AI_GATEWAY_ID?: string;
}

/** GET hits no loader logic — 404 so the endpoint leaks nothing on a casual probe. */
export function loader() {
  return new Response('Not Found', { status: 404 });
}

export async function action({ request, context }: Route.ActionArgs) {
  // The generated Env type lags wrangler.jsonc (the assistant bindings aren't in worker-configuration.d.ts
  // yet), so read these structurally — the same cast pattern as assistant.chat.tsx.
  const env = context.cloudflare.env as unknown as ReindexEnv;

  const auth = authorizeSeed(
    env.ASSISTANT_SEED_TOKEN,
    bearerToken(request.headers.get('authorization')),
  );
  // Unconfigured → behave as if the route does not exist; configured-but-wrong bearer → 403.
  if (auth.status === 'unconfigured') return new Response('Not Found', { status: 404 });
  if (auth.status === 'forbidden') return new Response('Forbidden', { status: 403 });

  if (!env.AI || !env.VECTORIZE) {
    console.error('[assistant] /reindex — AI/VECTORIZE binding not provisioned');
    return Response.json({ error: 'RAG bindings not provisioned' }, { status: 503 });
  }

  try {
    // Route the seed's embedding calls through the AI Gateway too (same slug as the chat path).
    const ai = gatewayRunner(env.AI, env.AI_GATEWAY_ID);
    const indexed = await indexSchemaCorpus(ai, env.VECTORIZE);
    return Response.json({ ok: true, indexed });
  } catch (error) {
    console.error('[assistant] /reindex failed', error);
    return Response.json({ error: 'reindex failed' }, { status: 502 });
  }
}
