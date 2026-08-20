// Thin Vercel-AI-SDK wiring (spec §2). Carries NO logic — it maps the SDK-agnostic tool registry
// (tools.ts) to SDK `tool()`s and runs the streamed tool-calling loop against the chat model, routed
// through the Cloudflare AI Gateway (§9.5). Everything testable lives in the pure modules; this layer
// needs `ASSISTANT_API_KEY` + bindings and is only exercised end-to-end on a deployed Worker.
//
// Provider-agnostic by design: the OpenAI-compatible provider is pointed at the AI Gateway, whose
// upstream (BgGPT via the mamay.ai AI Gateway Custom Provider `bggpt` today) and model are pure config
// — switch models/providers by editing `ASSISTANT_MODEL` / `AI_GATEWAY_BASE_URL`, no code change.
// Routing is MANDATORY: with no gateway URL configured we fail closed rather than call the provider
// directly (see `buildModel`).

import { createOpenAI } from '@ai-sdk/openai';
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
  type ToolSet,
  type UIMessage,
} from 'ai';
import { buildSystemPrompt } from './system-prompt';
import { createPhaseFilter } from './stream-phase';
import { createTranscriptSigner } from '../../../workers/assistant/transcript-signer';
import type { AssistantHmacEnv } from '../../../workers/assistant/transcript-hmac';
import { classifyStreamError, isGatewayRateLimit } from './stream-errors';
import { EMIT_REPORT_TOOL, INSUFFICIENT_DATA_MESSAGE } from '../assistant-contract/stream';
import { ASSISTANT_TOOLS, finalizeReport, type ToolContext } from './tools';
import { buildFallbackReport } from './report-fallback';
import {
  EMIT_REPORT_JSON_SCHEMA,
  verifyReport,
  buildStoredReport,
  persistReport as persistStoredReport,
  type GenerateFn,
  type VerificationOutcome,
  type ResolvedReport,
  type TemporalContext,
  type SourceFreshness,
} from '@sigma/report';

export interface AgentEnv {
  /** Provider API key (BgGPT/mamay today). SECRET — `wrangler secret put ASSISTANT_API_KEY`. */
  ASSISTANT_API_KEY: string;
  /**
   * REQUIRED — OpenAI-compatible endpoint of the Cloudflare AI Gateway upstream, e.g. (BgGPT wired as
   * the Custom Provider `bggpt`):
   * `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/custom-bggpt/v1`. Empty ⇒ fail closed
   * (we never call the provider directly). This is the single lever that guarantees LLM traffic
   * transits the gateway for logging / cost / rate-limit visibility (§9.5).
   */
  AI_GATEWAY_BASE_URL?: string;
  /** Model id, provider-scoped (e.g. `bggpt-gemma4-31b-it-bg-gptq-w4a16`). Swappable via config alone. */
  ASSISTANT_MODEL?: string;
  MAX_STEPS?: string;
}

const DEFAULT_MODEL = 'google/gemma-4-31b-it';
const DEFAULT_MAX_STEPS = 8;
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

/** Per-step tool-choice, as accepted by the SDK's `prepareStep` (a specific-tool force is an object). */
export type StepToolChoice =
  | 'auto'
  | 'required'
  | { type: 'tool'; toolName: 'emit_report' }
  | { type: 'tool'; toolName: 'reconcile_rollup' };

export interface ToolChoiceInput {
  stepNumber: number; // 0-based index of the step about to run
  maxSteps: number; // the hard step budget for this turn (stepCountIs)
  hasResults: boolean; // this turn's run_sql produced ≥1 bindable result handle
  reportEmitted: boolean; // a prior step already produced a valid (ok:true) report
  lastStepFailedEmit: boolean; // the previous step's emit_report returned ok:false (shape errors)
  rollupTouched: boolean; // any run_sql this turn read from a rollup summary table
  reconcileEmitted: boolean; // reconcile_rollup already returned Съгласувано. this turn
}

/**
 * Decide the tool-choice for the step about to run. Pure so the policy is unit-testable without the SDK.
 *
 * The load-bearing rule for weak models: DON'T let the turn end silently. A 27–31B model tends to burn
 * the whole step budget re-querying the same data (different date syntax, reformatting, double-checking)
 * and then run out BEFORE calling emit_report — so the user sees nothing. When the budget is nearly spent
 * (the final two steps) and we already hold bindable data but no report yet, FORCE emit_report so the turn
 * finalizes from what it has. The client then always renders either the report or the "couldn't compose"
 * affordance — never a blank turn. (Ordering + step-0 forcing rationale below.)
 */
export function chooseToolChoice(input: ToolChoiceInput): StepToolChoice {
  const {
    stepNumber,
    maxSteps,
    hasResults,
    reportEmitted,
    lastStepFailedEmit,
    rollupTouched,
    reconcileEmitted,
  } = input;
  // Force a real tool call on the FIRST step so a weak model can't narrate the call as prose (```sql).
  if (stepNumber === 0) return 'required';
  // Near the budget with gathered data but no report → force finalization from what we have, instead of
  // spending the last steps exploring and returning nothing. Checked before the failed-emit retry because
  // forcing the specific tool is strictly stronger than a bare 'required'.
  if (!reportEmitted && hasResults && stepNumber >= maxSteps - 2) {
    // Gap 1: if results touched a rollup summary table but reconcile hasn't run yet, force it first —
    // reconcile_rollup takes this step and emit_report the next, so the model never presents a
    // rollup-touching aggregate that hasn't been reconciled. Edge: when the window opens on the FINAL step
    // (data first binds late), reconcile consumes the last step and no emit_report is forced — the server
    // buildFallbackReport then composes the report, which is preferable to surfacing an unreconciled rollup.
    if (rollupTouched && !reconcileEmitted) {
      return { type: 'tool', toolName: 'reconcile_rollup' };
    }
    return { type: 'tool', toolName: 'emit_report' };
  }
  // A failed emit_report (shape errors returned to the model) → force a retry rather than let it drop to
  // prose.
  if (lastStepFailedEmit) return 'required';
  return 'auto';
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

// Verifier (role ④) call budget: one tool-less generateText per verified report, hard-capped in time
// so a slow gateway can never stall the emit_report tool result (the fail-closed path in verifyReport
// then strips the risk prose rather than blocking the turn).
const VERIFIER_TIMEOUT_MS = 20_000;

// The injected LLM call for verifyReport — same gateway-mandatory model as the main loop (§9.5),
// tool-less by construction. Verdicts only need a few hundred tokens; the low cap bounds cost and
// makes a steered long-form answer structurally impossible to return in full. Exactly ONE call:
// `maxRetries: 0` (the AI SDK counts retries on top of the initial call, so `1` would allow two
// gateway calls — doubling worst-case spend under the 120 RPM budget). The per-call timeout is
// combined with the turn's abort signal so a client disconnect cancels the verifier too.
function buildVerifierGenerate(env: AgentEnv, turnSignal?: AbortSignal): GenerateFn {
  const model = buildModel(env);
  return async ({ system, prompt }) => {
    const timeout = AbortSignal.timeout(VERIFIER_TIMEOUT_MS);
    const abortSignal = turnSignal ? AbortSignal.any([turnSignal, timeout]) : timeout;
    const result = await generateText({
      model,
      system,
      prompt,
      temperature: 0,
      maxRetries: 0,
      maxOutputTokens: 1024,
      abortSignal,
    });
    return result.text;
  };
}

// Shown when the model returns a completely empty turn — no report, no run_sql data to synthesize from,
// and no prose (an empty completion / finishReason 'other'). Guarantees the dock never renders a blank
// turn in that case. Opens with the canonical insufficient-data sentence (assistant-contract) so the
// server fallback, the system prompt's NO_DATA_RULE, and the dock's NO_ANSWER_FALLBACK stay in step.
export const EMPTY_COMPLETION_MESSAGE =
  `${INSUFFICIENT_DATA_MESSAGE} Опитайте отново или го формулирайте по-конкретно — ` +
  'напр. посочете възложител, период или сектор.';

// System-prompt version string used in StoredReport provenance for regression tracing. Derived — NOT a
// manual bump: a FNV-1a fingerprint of the CANONICAL system prompt (empty input → full dictionary, no
// per-turn bits), so any semantic edit to system-prompt.ts / describe-schema.ts re-fingerprints on the
// next deploy without anyone remembering to touch a constant. Not security-sensitive; a plain
// content hash is all provenance needs to correlate a stored report with the prompt that produced it.
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
const PROMPT_VERSION = `sp_${fnv1a(buildSystemPrompt({}))}`;

/** Generate a URL-safe random report ID (e.g. `r_a3f8c2d1e9b4`). */
function randomReportId(): string {
  return `r_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

// Gap 2: detect bare numeric tokens in assistant prose that should instead be bound via a result handle.
// Flags 5+-digit integers (avoids 4-digit years/CPV sub-codes) and currency-prefixed patterns.
// Only used for telemetry (console.warn) — never a hard block (false-positive risk on IDs, dates, etc.).
const BARE_NUMBER_RE = /\b\d{5,}\b|€\s*\d+|\b\d+\s*(?:хил\.|млн\.|млрд\.)/i;

function hasBareNumbers(text: string): boolean {
  return BARE_NUMBER_RE.test(text);
}

// Whitelist of recognised source values stored in provenance freshness rows.
// Rows with any other value are silently dropped rather than leaking an internal bucket name.
const KNOWN_FRESHNESS_SOURCES = new Set(['admin', 'ocds', 'eop'] as const);

async function fetchFreshness(db: D1Database): Promise<SourceFreshness[]> {
  try {
    const { results } = await db
      .prepare('SELECT source, as_of FROM data_freshness WHERE as_of IS NOT NULL')
      .all<{ source: string; as_of: string }>();
    return (results ?? [])
      .filter((r) => KNOWN_FRESHNESS_SOURCES.has(r.source as 'admin' | 'ocds' | 'eop'))
      .map((r) => ({ source: r.source as 'admin' | 'ocds' | 'eop', asOf: r.as_of }));
  } catch {
    return [];
  }
}

/**
 * Persist a resolved report to R2 and return its id + createdAt. Returns null on any write failure.
 *
 * Chat-coupled wrapper around `@sigma/report`'s pure `buildStoredReport` + `persistReport` (#167A
 * T1 decouple) — this function owns the chat-turn concerns (`ToolContext`, `randomReportId()`, the
 * `report/{id}.json` key, error swallowing); the shared package owns the `StoredReport` shape and
 * the R2 write itself, so the ETL weekly-digest producer can reuse both without a `ToolContext`.
 */
export async function persistReport(
  ctx: ToolContext,
  report: ResolvedReport,
  modelId: string,
  verification?: VerificationOutcome,
): Promise<{ reportId: string; createdAt: string } | null> {
  if (!ctx.reports) return null;
  const id = randomReportId();
  const stored = buildStoredReport({
    id,
    report,
    question: ctx.userQuestion ?? '',
    sources: ctx.sources,
    snapshot: ctx.results,
    freshness: await fetchFreshness(ctx.db),
    model: modelId,
    promptVersion: PROMPT_VERSION,
    // Role-④ audit trail (additive — absent on pre-verifier reports): what the verifier decided and
    // which claim ids it stripped/flagged, so a published report's missing prose is explainable.
    ...(verification
      ? {
          verification: {
            status: verification.status,
            strippedClaimIds: verification.strippedClaimIds,
            uncertainClaimIds: verification.uncertainClaimIds,
            // Diagnostic-only; server-side audit trail (report.tsx strips provenance before hydration).
            ...(verification.errors ? { errors: verification.errors } : {}),
          },
        }
      : {}),
  });
  try {
    await persistStoredReport(ctx.reports, `report/${id}.json`, stored);
    return { reportId: id, createdAt: stored.createdAt };
  } catch (err) {
    console.error('[assistant] failed to persist report to R2', err);
    return null;
  }
}

function buildToolSet(
  ctx: ToolContext,
  modelId: string,
  verify: (report: ResolvedReport) => Promise<VerificationOutcome>,
): ToolSet {
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
  set[EMIT_REPORT_TOOL] = tool({
    description:
      'Финализира справка. Блоковете реферират резултатни хендъли (R1…); сървърът свързва числата. ' +
      'Извикай го за всеки отговор с число, класация, сравнение или разбивка (виж системните правила).',
    inputSchema: jsonSchema(EMIT_REPORT_JSON_SCHEMA as unknown as Parameters<typeof jsonSchema>[0]),
    execute: async (input: unknown) => {
      const r = finalizeReport(input, ctx);
      if (!r.ok) return { ok: false as const, errors: r.errors };
      if (r.warnings.length > 0)
        console.warn('[assistant] partial report: missing display columns rendered as null', {
          warnings: r.warnings,
        });
      // Record that a valid report exists this turn, so chooseToolChoice stops force-finalizing on the
      // remaining steps (a legitimate multi-query flow that already emitted must not be re-forced).
      ctx.reportEmitted = true;
      // Role ④ (verifier.ts): risk-scaled and behind every deterministic gate — bindReport has already
      // bound/sanitized this report. Plain lookups resolve as 'skipped' with zero LLM cost; verifyReport
      // never throws, so a verifier failure degrades to its fail-closed strip, not a failed tool call.
      const verified = await verify(r.report);
      const persisted = await persistReport(ctx, verified.report, modelId, verified);
      if (persisted) ctx.persistedReport = persisted;
      return {
        ok: true as const,
        report: verified.report,
        ...(persisted ? { storedId: persisted.reportId } : {}),
      };
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
  // Deterministic, server-resolved temporal context for this turn (temporal.ts). Threaded into the system
  // prompt so the model uses absolute dates instead of guessing relative periods from its stale prior.
  temporal?: TemporalContext;
  abortSignal?: AbortSignal; // wire `request.signal` so a disconnect cancels the model loop (review #80)
  /**
   * Fired EXACTLY ONCE when generation settles, with the persisted report `{reportId, createdAt}` or
   * `null` (empty/error/abort). The dedup driver wires this to `ReportSingleFlight.complete/fail` so
   * waiters are woken (or released to regenerate). Fire-and-forget on the caller side (`ctx.waitUntil`).
   */
  onSettled?: (result: { reportId: string; createdAt: string } | null) => void;
  /**
   * §9.3 transcript signing (ADR-0011/0012). When present, this turn's server message is HMAC-signed
   * and stamped with a `message-metadata` chunk AFTER the phase filter — so it binds exactly the prose +
   * report chip the client stores, and the next turn's ingest gate can prove it authentic. Absent ⇒ the
   * assistant runs unsigned (feature unprovisioned: no `ASSISTANT_HMAC_KEY`).
   */
  signing?: { env: AssistantHmacEnv; conversationId: string; turnIndex: number };
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
  // Role ④ — one verifier closure per turn; verifyReport itself decides (deterministically) whether a
  // given report warrants the extra LLM call.
  const verifierGenerate = buildVerifierGenerate(opts.env, opts.abortSignal);
  const verify = (report: ResolvedReport) => verifyReport(report, verifierGenerate);

  // Resolves when the model loop (all steps + tool executions) is fully finished, so the last-resort
  // finalizer below runs only after the model has had every chance to emit its own report. `onError`
  // resolves it too (and flags the error) so the wrapping stream can never hang if the model throws —
  // and so we don't paste a synthesized report on top of a genuine provider-failure message.
  let resolveModelFinished!: () => void;
  const modelFinished = new Promise<void>((resolve) => {
    resolveModelFinished = resolve;
  });
  let modelErrored = false;
  // Captured from the model's finish so the wrapper can tell an EMPTY completion (weak model returns 0
  // tokens / finishReason 'other' under the gateway — reproducibly seen on some question shapes) from a
  // legitimate prose-only turn. Without this an empty completion with no run_sql dead-ends on a BLANK turn:
  // the fallback finalizer needs rows, so it can't fire, and nothing is ever written to the stream.
  let modelFinishReason: string | undefined;
  let modelProducedText = false;

  const result = streamText({
    onFinish: (event) => {
      modelFinishReason = event.finishReason;
      modelProducedText = typeof event.text === 'string' && event.text.trim().length > 0;
      // Gap 2 telemetry: when the model had real data to present but wrote numbers in prose instead of
      // binding via a result handle, log a warning for the Promise observer. Not a hard block — false
      // positives exist (dates, IDs, CPV codes), so this is a signal, not an enforcement gate.
      if (modelProducedText && opts.ctx.results.length > 0 && hasBareNumbers(event.text)) {
        // Redacted telemetry: the prose can contain personal names / a citizen's query echo, so log
        // only non-identifying signal (length), never the text itself (GDPR — no PII to Workers logs).
        console.warn(
          '[assistant] prose-number leak: bare numeric token in assistant text outside report',
          { textLen: event.text.length },
        );
      }
      resolveModelFinished();
    },
    onError: ({ error }) => {
      // The global BgGPT cap fires in AI Gateway at model-call time (§4) — tag the shed so it is
      // countable in Workers tail, distinct from provider outages.
      if (isGatewayRateLimit(error)) console.error('[assistant] gateway 429 — shedding turn');
      modelErrored = true;
      resolveModelFinished();
    },
    model: buildModel(opts.env),
    system: buildSystemPrompt({
      schemaContext: opts.schemaContext,
      freshness: opts.freshness,
      temporal: opts.temporal,
    }),
    messages,
    tools: buildToolSet(opts.ctx, modelId, verify),
    stopWhen: stepCountIs(maxSteps),
    // Force a real tool call on the FIRST step (then let the loop run free). Weaker chat models under the
    // streamed loop otherwise narrate the call as prose (writes ```sql / `[run_sql(...)]` instead of
    // invoking it) — `tool_choice: 'required'` makes that structurally impossible. Step 0 only: later
    // steps need `auto` so the model can finalize with `emit_report` and stop. Measured against the real
    // streamText path this took the failing cases from 0/4 to 4/4 (run_sql→emit_report). The matching
    // „run_sql FIRST, emit_report after" ordering rule lives in system-prompt.ts. A pure meta/clarifying
    // turn is also forced to call one tool first — it satisfies that with `answer_directly` (a no-op,
    // no-data escape hatch), NOT a junk run_sql probe, so no stray numeric result gets published as a
    // hollow report (the #69 residual; see answerDirectlyTool + NON_DATA_TURN_RULE).
    //
    // Additionally: if the last step contained a failed emit_report (ok:false — shape validation errors
    // returned to the model), force `required` again so the model retries the tool call rather than
    // falling back to prose. Without this the model answers in text then emits `ok:false` and stops.
    prepareStep: ({ stepNumber, steps }) => {
      const lastStep = steps[steps.length - 1];
      const lastStepFailedEmit = !!lastStep?.toolResults.some(
        (tr) => tr.toolName === 'emit_report' && (tr.output as { ok?: boolean }).ok === false,
      );
      return {
        toolChoice: chooseToolChoice({
          stepNumber,
          maxSteps,
          hasResults: opts.ctx.results.length > 0,
          reportEmitted: opts.ctx.reportEmitted === true,
          lastStepFailedEmit,
          rollupTouched: opts.ctx.rollupTouched === true,
          reconcileEmitted: opts.ctx.reconcileEmitted === true,
        }),
      };
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
  // Wrap the model's UI stream so we can append a SERVER-SYNTHESIZED report when the model gathered real
  // data but never produced a valid one. Without this a weak-model shape error / step-budget exhaustion
  // dead-ends the turn on „couldn't compose" even though the answer is already in ctx.results. The
  // injected part uses the SAME `tool-emit_report` shape the model would have produced, so the dock
  // renders a normal report chip; values are bound through bindReport (server-owned, never model-written).
  const stream = createUIMessageStream<UIMessage>({
    execute: async ({ writer }) => {
      try {
        // Drop reasoning/sources at source too — defense-in-depth with the phase filter downstream.
        // onError is required here: provider errors arrive as `error` parts of fullStream and are
        // masked by THIS hook (the SDK default is English "An error occurred."), not by the
        // createUIMessageStream onError below, which only sees execute/merge rejections.
        writer.merge(
          result.toUIMessageStream({
            sendReasoning: false,
            sendSources: false,
            onError: classifyStreamError,
          }),
        );
        // Wait for the model loop to settle before the last-resort finalizer, but never indefinitely.
        // onFinish/onError resolve `modelFinished` and in practice one always fires (incl. on abort), so
        // this timer is pure defense-in-depth: if the SDK ever failed to settle, the wrapper would keep the
        // response stream open forever. On backstop we BAIL without synthesizing — the loop's state is
        // indeterminate, so writing could race the still-open merged stream. Timer is cleared on the normal
        // path so it can't keep the isolate alive.
        const SETTLE_BACKSTOP_MS = 60_000;
        let backstopTimer: ReturnType<typeof setTimeout> | undefined;
        let settledCleanly = false;
        await Promise.race([
          modelFinished.then(() => {
            settledCleanly = true;
          }),
          new Promise<void>((resolve) => {
            backstopTimer = setTimeout(resolve, SETTLE_BACKSTOP_MS);
          }),
        ]);
        if (backstopTimer) clearTimeout(backstopTimer);
        if (!settledCleanly) {
          console.error(
            '[assistant] model stream did not settle within backstop — skipping fallback',
            {
              backstopMs: SETTLE_BACKSTOP_MS,
            },
          );
          return;
        }
        // Skip the fallback when the model finalized its own report, or errored (a provider failure already
        // surfaced its own message — don't paste a report over it).
        if (modelErrored || opts.ctx.reportEmitted) return;
        // No publishable outcome — either no bindable data, or data too thin to synthesize a real report.
        // If the model also produced no prose, the turn would otherwise be BLANK. Write an explicit
        // affordance so the dock shows guidance instead of an empty transcript; a legit prose-only answer
        // (produced text, e.g. a clarifying reply or a greeting) is left untouched.
        const writeEmptyAffordance = () => {
          if (modelProducedText) return;
          const textId = `empty_${randomReportId()}`;
          writer.write({ type: 'text-start', id: textId });
          writer.write({ type: 'text-delta', id: textId, delta: EMPTY_COMPLETION_MESSAGE });
          writer.write({ type: 'text-end', id: textId });
        };
        if (opts.ctx.results.length === 0) {
          if (!modelProducedText)
            console.warn('[assistant] empty completion — no report, no data, no prose', {
              finishReason: modelFinishReason,
            });
          writeEmptyAffordance();
          return;
        }
        try {
          const built = buildFallbackReport(opts.ctx.results, opts.ctx.userQuestion ?? '');
          if (!built.ok) {
            // Had rows yet no publishable report: bindReport rejected the shape, OR the result was too thin
            // to be an answer (a single row with no measure — the „Division / 45" probe defect, refused in
            // report-fallback.ts). Don't paste a hollow report; fall through to the same rephrase affordance
            // as the no-data case so a probe-only turn with no prose isn't left blank.
            console.warn('[assistant] fallback finalizer produced no valid report', {
              errors: built.errors,
              resultCount: opts.ctx.results.length,
            });
            writeEmptyAffordance();
            return;
          }
          if (built.warnings.length > 0)
            console.warn(
              '[assistant] partial fallback report: missing display columns rendered as null',
              {
                warnings: built.warnings,
              },
            );
          // Same ④ pass as the model path — the fallback's prose is deterministic (report-fallback.ts),
          // so this resolves as 'skipped' without an LLM call; running it anyway keeps the invariant
          // simple: no report reaches persist/stream unverified.
          const verified = await verify(built.report);
          const persisted = await persistReport(opts.ctx, verified.report, modelId, verified);
          if (persisted) opts.ctx.persistedReport = persisted;
          const toolCallId = `fallback_${randomReportId()}`;
          // Reuse EMIT_REPORT_TOOL (the same constant the tool registry and model path use) so a future
          // rename of the tool name can't silently desync this synthesized fallback part from the real tool.
          writer.write({ type: 'tool-input-start', toolCallId, toolName: EMIT_REPORT_TOOL });
          writer.write({
            type: 'tool-input-available',
            toolCallId,
            toolName: EMIT_REPORT_TOOL,
            input: {},
          });
          writer.write({
            type: 'tool-output-available',
            toolCallId,
            output: {
              ok: true as const,
              report: verified.report,
              ...(persisted ? { storedId: persisted.reportId } : {}),
            },
          });
          opts.ctx.reportEmitted = true;
        } catch (err) {
          // The fallback is best-effort: never let it break the response the model already streamed.
          console.error('[assistant] fallback finalizer failed', err);
        }
      } finally {
        // Exactly-once settle signal for the dedup driver — all exit paths above route through here.
        opts.onSettled?.(opts.ctx.persistedReport ?? null);
      }
    },
    // Graceful degradation (§7): anything that escapes execute/merge (provider errors take the
    // toUIMessageStream onError above instead) surfaces as a readable Bulgarian line, not a broken
    // connection — a gateway 429 gets the distinct shed message (§3), everything else the generic
    // one. We log the raw error server-side (Workers tail); no server detail reaches the user.
    onError: (error) => {
      console.error('[assistant] stream error', error);
      return classifyStreamError(error);
    },
  });
  // Only phases + prose + the resolved report reach the dock — the wrapped stream (model loop + any
  // synthesized fallback report) runs through the allowlist filter; internals never leave the Worker.
  const filtered = stream.pipeThrough(createPhaseFilter());
  // §9.3: sign AFTER the phase filter, so the metadata binds exactly the prose + report chip the client
  // stores (not the model's stripped tool traffic). Only when a key is configured (ADR-0012 §5).
  const outbound = opts.signing
    ? filtered.pipeThrough(
        createTranscriptSigner(opts.signing.env, {
          conversationId: opts.signing.conversationId,
          turnIndex: opts.signing.turnIndex,
        }),
      )
    : filtered;
  return createUIMessageStreamResponse({ stream: outbound });
}
