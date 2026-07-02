// Thin Vercel-AI-SDK wiring (spec §2). Carries NO logic — it maps the SDK-agnostic tool registry
// (tools.ts) to SDK `tool()`s and runs the streamed tool-calling loop against the chat model, routed
// through the Cloudflare AI Gateway (§9.5). Everything testable lives in the pure modules; this layer
// needs `ASSISTANT_API_KEY` + bindings and is only exercised end-to-end on a deployed Worker.
//
// Provider-agnostic by design: the OpenAI-compatible provider is pointed at the AI Gateway, whose
// upstream (OpenRouter today) and model are pure config — switch models/providers by editing
// `ASSISTANT_MODEL` / `AI_GATEWAY_BASE_URL`, no code change. Routing is MANDATORY: with no gateway
// URL configured we fail closed rather than call the provider directly (see `buildModel`).

import { createOpenAI } from '@ai-sdk/openai';
import {
  convertToModelMessages,
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
  type ToolSet,
  type UIMessage,
} from 'ai';
import { buildSystemPrompt } from './system-prompt';
import { EMIT_REPORT_JSON_SCHEMA } from './emit-report-schema';
import { ASSISTANT_TOOLS, finalizeReport, type ToolContext } from './tools';

export interface AgentEnv {
  /** Provider API key (OpenRouter today). SECRET — `wrangler secret put ASSISTANT_API_KEY`. */
  ASSISTANT_API_KEY: string;
  /**
   * REQUIRED — OpenAI-compatible endpoint of the Cloudflare AI Gateway upstream, e.g.
   * `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openrouter/v1`. Empty ⇒ fail closed
   * (we never call the provider directly). This is the single lever that guarantees LLM traffic
   * transits the gateway for logging / cost / rate-limit visibility (§9.5).
   */
  AI_GATEWAY_BASE_URL?: string;
  /** Model id, provider-scoped (e.g. `google/gemma-4-31b-it`). Swappable via config alone. */
  ASSISTANT_MODEL?: string;
  MAX_STEPS?: string;
}

const DEFAULT_MODEL = 'google/gemma-4-31b-it';
const DEFAULT_MAX_STEPS = 6;
// Hard ceiling on the tool-loop length regardless of env, bounding worst-case model calls per turn.
// `MAX_STEPS` is operator-supplied config — a misconfigured deploy could otherwise stall the loop
// (0/negative) or uncap it (a huge value). (review #80)
const MAX_STEPS_CAP = 20;

/**
 * Resolve the tool-loop step budget from the (untrusted) env string: fall back to the default on a
 * missing / non-numeric / < 1 value, and clamp to [1, MAX_STEPS_CAP].
 */
export function resolveMaxSteps(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_STEPS;
  return Math.min(Math.floor(n), MAX_STEPS_CAP);
}

// `.chat()` forces the chat-completions endpoint (not the OpenAI Responses API), which is what the
// gateway upstream (OpenRouter/BgGPT/etc.) speaks.
//
// Fail closed: refuse to build a model unless the AI Gateway base URL is configured. Without it the
// only alternative is a direct provider call, which would silently bypass the gateway's logging, cost
// accounting and rate limiting — exactly the visibility guarantee we require. The chat route also
// gates on this up front (503), so in practice this throw is defense-in-depth.
function buildModel(env: AgentEnv) {
  const baseURL = env.AI_GATEWAY_BASE_URL?.trim();
  if (!baseURL) {
    throw new Error(
      'AI_GATEWAY_BASE_URL is not set — refusing to reach the model provider outside the Cloudflare AI Gateway',
    );
  }
  const provider = createOpenAI({ baseURL, apiKey: env.ASSISTANT_API_KEY });
  return provider.chat(env.ASSISTANT_MODEL || DEFAULT_MODEL);
}

// System-prompt version string used in StoredReport provenance for regression tracing.
// Bump this whenever system-prompt.ts changes semantically.
const PROMPT_VERSION = '2026-06-28';

/** Generate a URL-safe random report ID (e.g. `r_a3f8c2d1e9b4`). */
function randomReportId(): string {
  return `r_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

// Whitelist of recognised source values stored in provenance freshness rows.
// Rows with any other value are silently dropped rather than leaking an internal bucket name.
const KNOWN_FRESHNESS_SOURCES = new Set(['admin', 'ocds', 'eop'] as const);

async function fetchFreshness(db: D1Database): Promise<{ source: string; asOf: string }[]> {
  try {
    const { results } = await db
      .prepare('SELECT source, as_of FROM data_freshness WHERE as_of IS NOT NULL')
      .all<{ source: string; as_of: string }>();
    return (results ?? [])
      .filter((r) => KNOWN_FRESHNESS_SOURCES.has(r.source as 'admin' | 'ocds' | 'eop'))
      .map((r) => ({ source: r.source, asOf: r.as_of }));
  } catch {
    return [];
  }
}

/** Persist a resolved report to R2 and return its ID. Returns null on any write failure. */
async function persistReport(
  ctx: ToolContext,
  report: ReturnType<typeof finalizeReport> & { ok: true },
  modelId: string,
): Promise<string | null> {
  if (!ctx.reports) return null;
  const id = randomReportId();
  const stored = {
    schemaVersion: 1,
    id,
    createdAt: new Date().toISOString(),
    report: report.report,
    provenance: {
      question: ctx.userQuestion ?? '',
      sources: ctx.sources,
      snapshot: ctx.results,
      freshness: await fetchFreshness(ctx.db),
      model: modelId,
      promptVersion: PROMPT_VERSION,
    },
  };
  try {
    await ctx.reports.put(`report/${id}.json`, JSON.stringify(stored), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        title: report.report.title,
        question: ctx.userQuestion ?? '',
        createdAt: stored.createdAt,
      },
    });
    return id;
  } catch (err) {
    console.error('[assistant] failed to persist report to R2', err);
    return null;
  }
}

function buildToolSet(ctx: ToolContext, modelId: string): ToolSet {
  const set: ToolSet = {};
  for (const t of ASSISTANT_TOOLS) {
    set[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters as unknown as Parameters<typeof jsonSchema>[0]),
      execute: async (input: unknown) => t.execute((input ?? {}) as Record<string, unknown>, ctx),
    });
  }
  // Terminal tool — finalizes the report by binding values from THIS turn's server-executed results
  // (never client-supplied). Returns validation errors for the model to retry against (§4, §9.1).
  set.emit_report = tool({
    description:
      'Финализира справка. Блоковете реферират резултатни хендъли (R1…); сървърът свързва числата. ' +
      'Извикай го за всеки отговор с число, класация, сравнение или разбивка (виж системните правила).',
    inputSchema: jsonSchema(EMIT_REPORT_JSON_SCHEMA as unknown as Parameters<typeof jsonSchema>[0]),
    execute: async (input: unknown) => {
      const r = finalizeReport(input, ctx);
      if (!r.ok) return { ok: false as const, errors: r.errors };
      const storedId = await persistReport(ctx, r, modelId);
      return { ok: true as const, report: r.report, ...(storedId ? { storedId } : {}) };
    },
  });
  return set;
}

export interface RunAssistantOptions {
  env: AgentEnv;
  ctx: ToolContext;
  messages: UIMessage[];
  schemaContext?: string[];
  freshness?: string;
  abortSignal?: AbortSignal; // wire `request.signal` so a disconnect cancels the model loop (review #80)
}

/**
 * Run one assistant turn: the chat model (via AI Gateway) + the bounded tool loop, returned as the streamed
 * UI-message Response the chat route hands back to the dock. (Returns a `Response` rather than the
 * SDK result so no internal SDK type leaks across the module boundary.)
 */
export async function runAssistant(opts: RunAssistantOptions): Promise<Response> {
  const maxSteps = resolveMaxSteps(opts.env.MAX_STEPS);
  const messages = await convertToModelMessages(opts.messages);
  const modelId = opts.env.ASSISTANT_MODEL || DEFAULT_MODEL;
  const result = streamText({
    model: buildModel(opts.env),
    system: buildSystemPrompt({ schemaContext: opts.schemaContext, freshness: opts.freshness }),
    messages,
    tools: buildToolSet(opts.ctx, modelId),
    stopWhen: stepCountIs(maxSteps),
    // Force a real tool call on the FIRST step (then let the loop run free). Weaker chat models under the
    // streamed loop otherwise narrate the call as prose (writes ```sql / `[run_sql(...)]` instead of
    // invoking it) — `tool_choice: 'required'` makes that structurally impossible. Step 0 only: later
    // steps need `auto` so the model can finalize with `emit_report` and stop. Measured against the real
    // streamText path this took the failing cases from 0/4 to 4/4 (run_sql→emit_report). The matching
    // „run_sql FIRST, emit_report after" ordering rule lives in system-prompt.ts. Trade-off: a pure
    // meta/clarifying turn is also forced to call one tool first (usually describe_schema) — acceptable
    // for a data-analysis assistant where nearly every turn is a data question.
    //
    // Additionally: if the last step contained a failed emit_report (ok:false — shape validation errors
    // returned to the model), force `required` again so the model retries the tool call rather than
    // falling back to prose. Without this the model answers in text then emits `ok:false` and stops.
    prepareStep: ({ stepNumber, steps }) => {
      if (stepNumber === 0) return { toolChoice: 'required' };
      const lastStep = steps[steps.length - 1];
      const hadFailedReport = lastStep?.toolResults.some(
        (tr) => tr.toolName === 'emit_report' && (tr.output as { ok: boolean }).ok === false,
      );
      return { toolChoice: hadFailedReport ? 'required' : 'auto' };
    },
    // Bound worst-case resource use (review #80): cancel on client disconnect; one explicit retry
    // (the SDK default of 2 silently multiplies the per-step call count beyond the visible step cap);
    // a per-step output backstop (the model emits block structure + refs, not the bound data values).
    abortSignal: opts.abortSignal,
    maxRetries: 1,
    // Low temperature materially improves tool-calling reliability with weaker chat models: under the
    // streamed tool loop the model otherwise drifts into NARRATING the call (writing `run_sql(...)` /
    // ```sql as prose) instead of emitting a real function call. Local probes: ~75% tool-call rate at
    // the model default vs ~88% at 0.1 (streamed). Determinism here is desirable — we want the SQL, not
    // creative variation.
    temperature: 0.1,
    // Per-step output backstop. The model emits block structure + refs (not the bound data values),
    // but a longer multi-block справка plus reasoning can exceed 4k and get truncated mid-report; 8k
    // leaves headroom while still capping worst-case tokens per step.
    maxOutputTokens: 8192,
  });
  return result.toUIMessageStreamResponse({
    // Graceful degradation (§7): a provider outage / rate-limit / timeout surfaces mid-stream as a
    // readable Bulgarian line instead of a broken connection. The SDK default redacts the error to
    // "An error occurred." to avoid leaking server details — we log it server-side (Workers tail)
    // and show our own message. A full rate-limit + circuit-breaker is the launch gate (README).
    onError: (error) => {
      console.error('[assistant] stream error', error);
      return 'Асистентът временно не е достъпен. Опитай отново след малко.';
    },
  });
}
