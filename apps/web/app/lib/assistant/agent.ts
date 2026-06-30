// Thin Vercel-AI-SDK wiring (spec §2). Carries NO logic — it maps the SDK-agnostic tool registry
// (tools.ts) to SDK `tool()`s and runs the streamed tool-calling loop against BgGPT, routed through
// the Cloudflare AI Gateway (§9.5). Everything testable lives in the pure modules; this layer needs
// `BGGPT_API_KEY` + bindings and is only exercised end-to-end on a deployed Worker.

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
  BGGPT_API_KEY: string;
  AI_GATEWAY_BASE_URL?: string; // OpenAI-compatible AI Gateway passthrough; empty → api.bggpt.ai (§9.5)
  BGGPT_MODEL?: string;
  MAX_STEPS?: string;
}

const DEFAULT_MODEL = 'bggpt-gemma-3-27b-fp8';
const DEFAULT_BASE_URL = 'https://api.bggpt.ai/v1';
const DEFAULT_MAX_STEPS = 6;
// Hard ceiling on the tool-loop length regardless of env, bounding worst-case BgGPT calls per turn.
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

// `.chat()` forces the chat-completions endpoint BgGPT speaks (not the OpenAI Responses API).
function buildModel(env: AgentEnv) {
  const provider = createOpenAI({
    baseURL: env.AI_GATEWAY_BASE_URL || DEFAULT_BASE_URL,
    apiKey: env.BGGPT_API_KEY,
  });
  return provider.chat(env.BGGPT_MODEL || DEFAULT_MODEL);
}

function buildToolSet(ctx: ToolContext): ToolSet {
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
      return r.ok
        ? { ok: true as const, report: r.report }
        : { ok: false as const, errors: r.errors };
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
  abortSignal?: AbortSignal; // wire `request.signal` so a disconnect cancels the BgGPT loop (review #80)
}

/**
 * Run one assistant turn: BgGPT (via AI Gateway) + the bounded tool loop, returned as the streamed
 * UI-message Response the chat route hands back to the dock. (Returns a `Response` rather than the
 * SDK result so no internal SDK type leaks across the module boundary.)
 */
export async function runAssistant(opts: RunAssistantOptions): Promise<Response> {
  const maxSteps = resolveMaxSteps(opts.env.MAX_STEPS);
  const messages = await convertToModelMessages(opts.messages);
  const result = streamText({
    model: buildModel(opts.env),
    system: buildSystemPrompt({ schemaContext: opts.schemaContext, freshness: opts.freshness }),
    messages,
    tools: buildToolSet(opts.ctx),
    stopWhen: stepCountIs(maxSteps),
    // Bound worst-case resource use (review #80): cancel on client disconnect; one explicit retry
    // (the SDK default of 2 silently multiplies the per-step call count beyond the visible step cap);
    // a per-step output backstop (the model emits block structure + refs, not the bound data values).
    abortSignal: opts.abortSignal,
    maxRetries: 1,
    maxOutputTokens: 4096,
  });
  return result.toUIMessageStreamResponse({
    // Graceful degradation (§7): a BgGPT outage / rate-limit / timeout surfaces mid-stream as a
    // readable Bulgarian line instead of a broken connection. The SDK default redacts the error to
    // "An error occurred." to avoid leaking server details — we log it server-side (Workers tail)
    // and show our own message. A full rate-limit + circuit-breaker is the launch gate (README).
    onError: (error) => {
      console.error('[assistant] stream error', error);
      return 'Асистентът временно не е достъпен. Опитай отново след малко.';
    },
  });
}
