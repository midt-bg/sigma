// Resource route: the assistant chat endpoint. The dock POSTs the UIMessage history; we run one
// agent turn (the chat model via the AI Gateway + the read-only tool loop) and stream the result
// back. The server is stateless (spec §5) — nothing per-user is persisted here.

import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';
import type { Route } from './+types/assistant.chat';
import { runAssistant, type AgentEnv } from '../lib/assistant/agent';
import {
  gatewayRunner,
  retrieveSchemaContext,
  type EmbeddingRunner,
  type VectorIndex,
} from '../lib/assistant/rag';
import {
  resolveRowsReadBudget,
  resolveSqlTimeoutMs,
  type ToolContext,
} from '../lib/assistant/tools';
import { firstPartyRejection } from '../lib/assistant/request-guard';
import { turnstileRejection } from '../lib/assistant/turnstile';
import { resolveTemporalContext } from '../lib/assistant/temporal';
import { assistantEnabled } from '../lib/assistant/enabled';
import { freshnessVersion } from '../lib/csv-export';
import { freshnessToken, type DedupHit } from '../../workers/assistant/dedup';
import { buildDedupRequest, type DedupRequest } from '../../workers/assistant/dedup-request';
import { dedupPart } from '../../workers/assistant/dedup-stream';
import { gateTranscript, type Signing } from '../lib/assistant/transcript-gate';
import { createTranscriptSigner } from '../../workers/assistant/transcript-signer';
import type { AssistantHmacEnv } from '../../workers/assistant/transcript-hmac';
import { rateLimitBgGptGlobal } from '../../workers/bggpt-global-rate-limit';

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

// Client dedup fields are a trust boundary (dedup.ts caller contract): bound + charset-check before they
// key the cache. clientRequestId is an opaque idempotency token; filterContext is folded into the L1 key.
const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_FILTER_CONTEXT_CHARS = 512;

function parseClientRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && CLIENT_REQUEST_ID_RE.test(value) ? value : undefined;
}

function parseFilterContext(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_FILTER_CONTEXT_CHARS ? trimmed : undefined;
}

// §9.3 conversation binding (ADR-0011): the client mints a stable opaque id per thread and echoes it
// every turn; the server binds it into each message signature. Not a secret — an attacker choosing
// their own id only scopes forgeries that still fail without the key. An absent/malformed id becomes
// '' , which drops every signed message (secure default) rather than verifying against a wildcard.
const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
function parseConversationId(value: unknown): string {
  return typeof value === 'string' && CONVERSATION_ID_RE.test(value) ? value : '';
}

// A standalone UI-message stream carrying ONLY the `data-dedup` part — served when an existing report
// satisfies the turn. One curated part, so it needs no phase filter (that seam strips the model's tool
// traffic; there is none here). The dock renders the "reuse existing report" affordance from it (3c).
function dedupResponse(hit: DedupHit, signing?: Signing): Response {
  const base = createUIMessageStream<UIMessage>({
    execute: ({ writer }) => {
      writer.write(dedupPart(hit));
    },
  });
  // §9.3: a cache-hit is a server-authored assistant message too — sign it so it survives the next
  // turn's ingest gate (its chip binds the reused /reports/:id). No-op when unsigned (no key).
  const stream = signing
    ? base.pipeThrough(
        createTranscriptSigner(signing.env, {
          conversationId: signing.conversationId,
          turnIndex: signing.turnIndex,
        }),
      )
    : base;
  return createUIMessageStreamResponse({ stream });
}

export async function action({ request, context }: Route.ActionArgs) {
  // Launch gate FIRST — a dark assistant does no work, spends nothing, and reveals no behaviour. Checked
  // before the CSRF guard / body read so a held-back or killed endpoint is the cheapest possible reject.
  if (!assistantEnabled(context.cloudflare.env.ASSISTANT_ENABLED)) {
    return Response.json({ error: 'Асистентът не е активен.' }, { status: 503 });
  }

  // First-party guard BEFORE buffering the body: a cross-site page must not be able to start a paid BgGPT
  // turn from a victim's browser (CSRF → denial-of-wallet). Requiring application/json forces a preflight
  // on any cross-origin fetch (never green-lit) and blocks <form> CSRF (review #80, lyubomir-bozhinov).
  const rejection = firstPartyRejection({
    method: request.method,
    contentType: request.headers.get('Content-Type'),
    secFetchSite: request.headers.get('Sec-Fetch-Site'),
  });
  if (rejection) return Response.json({ error: rejection.error }, { status: rejection.status });

  // Turnstile edge gate (spec §7): verify the client's bot-check token BEFORE buffering the body or
  // doing any paid model/D1 work. No-op until TURNSTILE_SECRET is provisioned outside prod
  // (dev/preview/staging); in production a missing secret fails closed (503) — see turnstile.ts.
  const turnstile = await turnstileRejection(request, context.cloudflare.env, import.meta.env.PROD);
  if (turnstile) return Response.json({ error: turnstile.error }, { status: turnstile.status });

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
  let parsed: {
    messages?: UIMessage[];
    clientRequestId?: unknown;
    filterContext?: unknown;
    conversationId?: unknown;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return Response.json({ error: 'невалиден JSON' }, { status: 400 });
  }
  // Optional dedup fields (sent by the dock from 3c; absent today). Validated at this boundary.
  const clientRequestId = parseClientRequestId(parsed.clientRequestId);
  const filterContext = parseFilterContext(parsed.filterContext);
  const conversationId = parseConversationId(parsed.conversationId);
  const env = context.cloudflare.env;

  // §9.3 transcript integrity (ADR-0011/0012): before the model reads ANY prior turn, drop every
  // assistant/tool message that is not a current, authentic, in-order, same-conversation server emission
  // — closing forgery, replay, reordering, cross-conversation splicing and report-chip laundering. The
  // gate VERIFIES on the full messages (chips bind the signature) and only then strips them to the
  // text-only, role-filtered, recency-capped view the model consumes. Gated on the RUNTIME `ENVIRONMENT`
  // binding, never the `import.meta.env.PROD` build constant (which inlines `true` for staging too — the
  // misclassification flagged in review #64). Production without a key fails closed; dev/preview without a
  // key runs with the filter off (feature unprovisioned), mirroring Turnstile.
  const hmacKey = (env as { ASSISTANT_HMAC_KEY?: string }).ASSISTANT_HMAC_KEY?.trim();
  // Stable public deploys (production + staging, both live/unauthenticated) MUST have a key — an
  // unsigned transcript there would let the model read forgeable history. Ephemeral previews stay
  // fail-open (they can run UI-only without the key); local dev has no ENVIRONMENT and stays open.
  const deployEnv = (env as { ENVIRONMENT?: string }).ENVIRONMENT;
  const gate = await gateTranscript({
    rawMessages: parsed.messages,
    conversationId,
    hmacKey,
    requireKey: deployEnv === 'production' || deployEnv === 'staging',
    env: env as AssistantHmacEnv,
    maxMessages: MAX_MESSAGES,
  });
  if (gate.refuse) {
    console.error(
      '[assistant] ASSISTANT_HMAC_KEY unset in production — refusing (fail closed, §9.3)',
    );
    return Response.json({ error: 'Асистентът временно не е достъпен.' }, { status: 503 });
  }
  if (gate.dropped.length > 0) {
    console.warn('[assistant] dropped inauthentic transcript messages (§9.3)', {
      dropped: gate.dropped,
    });
  }
  const messages = gate.messages;
  if (messages.length === 0) return Response.json({ error: 'няма съобщения' }, { status: 400 });
  // The total body cap leaves room for ONE message to dominate (re-billed as prompt tokens every step);
  // reject an oversized individual message too (review #80).
  if (messages.some((m) => messageTextChars(m) > MAX_MESSAGE_CHARS)) {
    return Response.json({ error: 'съобщението е твърде дълго' }, { status: 413 });
  }
  // §9.3 emit slot: sign this turn's server message (and any dedup cache-hit) when a key is configured.
  const signing: Signing | undefined = gate.signing;

  // Fail fast and CLEARLY if the assistant is unprovisioned, rather than starting a turn that surfaces a
  // generic mid-stream 401 indistinguishable from a real outage (review #80). We require BOTH the
  // provider key AND the AI Gateway base URL: routing through the gateway is mandatory (fail closed),
  // so a missing gateway URL is "unconfigured", not a licence to call the provider directly.
  const agentEnv = env as unknown as AgentEnv & { AI_GATEWAY_ID?: string };
  if (!agentEnv.ASSISTANT_API_KEY || !agentEnv.AI_GATEWAY_BASE_URL?.trim()) {
    console.error(
      '[assistant] ASSISTANT_API_KEY / AI_GATEWAY_BASE_URL not set — endpoint not provisioned',
    );
    return Response.json({ error: 'Асистентът все още не е конфигуриран.' }, { status: 503 });
  }
  // Route RAG embeddings (Workers AI) through the same AI Gateway as the LLM, so ALL model traffic is
  // observable in one place (§9.5). The gateway slug comes from `AI_GATEWAY_ID`.
  const ai = env.AI
    ? gatewayRunner(env.AI as unknown as EmbeddingRunner, agentEnv.AI_GATEWAY_ID)
    : undefined;
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
    sources: [],
    userQuestion: question,
    // Per-turn Denial-of-Wallet guard (issue #122): bound the D1 rows-read cost of this turn's run_sql
    // calls. `LIMIT` caps only returned rows; D1 bills on rows scanned.
    rowsRead: 0,
    rowsReadBudget: resolveRowsReadBudget(env.D1_ROWS_READ_BUDGET),
    // Per-query wall-time bound for run_sql (§9.4, gate #83).
    sqlTimeoutMs: resolveSqlTimeoutMs(env.RUN_SQL_TIMEOUT_MS),
    // R2 bucket for report persistence (Lane C4). Optional — absent until the REPORTS binding is deployed.
    reports: env.REPORTS,
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

  // Deterministic temporal grounding: resolve any relative Bulgarian period phrase in the question to
  // absolute ISO bounds from the server clock, so the model uses real dates instead of guessing from its
  // stale training prior (temporal.ts). Undefined when the question carries no period phrase — no block,
  // no injected filter.
  const temporal = question
    ? (resolveTemporalContext(question, new Date()) ?? undefined)
    : undefined;

  // ── Report dedup (Lane F) ──────────────────────────────────────────────────────────────────────
  // Collapse concurrent identical questions onto ONE generation and serve an existing report when the
  // underlying data is unchanged. Fully optional: with the KV / DO bindings absent (local dev, an
  // unprovisioned deploy) the assistant still runs — every turn just generates. Fail toward regeneration
  // on every uncertain branch (a GC'd artifact, a driver crash, a stale freshness token all → regenerate).
  const flightNs = env.REPORT_SINGLE_FLIGHT;
  let dedup: DedupRequest | null = null;
  let freshness = '';
  if (env.DEDUP_KV && flightNs && question) {
    // Reuse csv-export's exact derivation of `home_totals.refreshed_at` so both caches invalidate in
    // lockstep. `freshnessVersion` returns the sentinel 'v0' when the data version is UNKNOWN (home_totals
    // absent / unrefreshed — a bootstrap or ETL-gap window). Under a fixed epoch a report cached now would
    // still validate after the data changes but before refreshed_at updates → a stale serve (strict
    // review). So when the version is unknown we DON'T dedup: every request generates (fail toward
    // regeneration) until a real refreshed_at lands.
    const dataVersion = await freshnessVersion(env.DB);
    if (dataVersion !== 'v0') {
      freshness = freshnessToken({ refreshedAt: dataVersion, buildId: env.BUILD_ID ?? 'dev' });
      dedup = buildDedupRequest({
        clientRequestId,
        prompt: question,
        // L1 dedup is restricted to a period with STABLE, absolute bounds (ADR-0010). `period` absent
        // (all-time / no date phrase) → skip L1. A clock-relative phrase („този месец", „последните 30 дни")
        // or an explicit period still running (clamped to-date: „за 2026" mid-year) has `stableBounds:false`
        // → skip L1, so a drifting window is never served from a prompt-keyed cache. A fully-settled explicit
        // range/year („2025", or a fixed ISO range whose end the clock has already passed) is stable → dedups
        // (it may still show a freshness caveat; the data-version token busts the cache on refresh). NB:
        // `stableBounds:false` (not recencyCaveat) is the gate — a recent-but-fixed range is dedup-safe yet
        // still carries a caveat.
        period: temporal?.primary,
        periodSettling: temporal?.primary.stableBounds === false,
        filterContext,
        freshness,
      });
    }
  }

  const cfCtx = context.cloudflare.ctx;
  const isProd = import.meta.env.PROD;
  try {
    if (flightNs && dedup && dedup.doName) {
      const { payloads } = dedup;
      const stub = flightNs.get(flightNs.idFromName(dedup.doName));
      const claim = await stub.claimAndWait(dedup.signals, freshness);
      if (claim.kind === 'hit' || claim.kind === 'ready') {
        // 'ready' = a concurrent driver just generated it; attribute it to the layer the DO collapsed on
        // (the doName prefix — L0 when L1 was unsafe), for accurate telemetry, not a hardcoded 'L1'.
        // A cache hit is FREE — it never consults the global breaker (else a viral report link would trip
        // the DoW cap on requests that cost nothing to serve, defeating this whole dedup lane).
        const layer =
          claim.kind === 'hit' ? claim.layer : dedup.doName.startsWith('L0|') ? 'L0' : 'L1';
        return dedupResponse(
          { reportId: claim.reportId, createdAt: claim.createdAt, layer },
          signing,
        );
      }
      // This branch generates (paid) → consult the account-wide breaker BEFORE the model call (#135).
      const denied = await rateLimitBgGptGlobal(request, env.BGGPT_CIRCUIT_BREAKER, isProd);
      if (denied) return denied;
      // 'driver' → generate and broker the result to any waiters. 'regenerate' (rare: a prior driver
      // crashed/timed out) → just regenerate uncoordinated; the next identical turn re-warms the cache.
      // ponytail: regenerate skips the KV write — self-heals on the next driver, not worth a 2nd path.
      const onSettled =
        claim.kind === 'driver'
          ? (result: { reportId: string; createdAt: string } | null): void => {
              cfCtx.waitUntil(
                (result ? stub.complete(payloads, freshness, result) : stub.fail()).catch(() => {}),
              );
            }
          : undefined;
      return await runAssistant({
        env: env as unknown as AgentEnv,
        ctx,
        messages,
        schemaContext,
        temporal,
        abortSignal: request.signal,
        onSettled,
        signing,
      });
    }
    // Dedup disabled (no KV/DO binding, or no safe key) → generate; still gate on the global breaker.
    const denied = await rateLimitBgGptGlobal(request, env.BGGPT_CIRCUIT_BREAKER, isProd);
    if (denied) return denied;
    return await runAssistant({
      env: env as unknown as AgentEnv,
      ctx,
      messages,
      schemaContext,
      temporal,
      abortSignal: request.signal,
      signing,
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
