// The seam that makes only PHASES reach the dock, not the raw agent stream. A TransformStream over
// the SDK's UI-message chunks that forwards a strict ALLOWLIST — conversational text, structural
// markers, the masked error line, and the terminal `emit_report` (the rendered product) — and drops
// everything else: run_sql's SQL input assembled token-by-token, its raw D1 rows, reasoning, and any
// unknown/future chunk type (fail closed across SDK upgrades). In place of the dropped tool traffic
// it injects `transient` `data-phase` parts, so the dock can show „Търся в данните…" without ever
// receiving the SQL or rows.

import type { UIMessageChunk } from 'ai';
import {
  EMIT_REPORT_TOOL,
  PHASE_PART,
  REPORT_FAILED_MESSAGE,
  REPORT_READY_PART,
  type AssistantPhase,
} from '../assistant-contract/stream';

// The only tool whose chunks reach the client (its input is a block skeleton referencing result
// handles R1…, its output the resolved report the dock renders); every other tool is internal.
// The user-facing failure line the dock shows for a rejected report — also the mask for a thrown one.
// A TECHNICAL failure, not a data statement — hence REPORT_FAILED_MESSAGE, never the
// insufficient-data wording (the data may exist; only the compose step failed).
const REPORT_FAILED_TEXT = REPORT_FAILED_MESSAGE;

// Non-tool chunk types forwarded verbatim. `error` is already masked upstream (toUIMessageStream's
// onError); reasoning is dropped at the source (sendReasoning: false) and NOT listed here so it
// stays dropped even if that flag ever flips.
const PASS_TYPES = new Set([
  'text-start',
  'text-delta',
  'text-end',
  'start-step',
  'finish-step',
  'finish',
  'abort',
  'error',
]);

type Controller = TransformStreamDefaultController<UIMessageChunk>;

/**
 * Filter the raw SDK UI-message stream into the client-safe wire: allowlisted chunks pass, internal
 * tool traffic is replaced by coarse phase signals. Must never throw — it sits downstream of the
 * stream's onError, so a throw here would abort the response body instead of masking the error.
 */
export function createPhaseFilter(): TransformStream<UIMessageChunk, UIMessageChunk> {
  const toolNames = new Map<string, string>(); // toolCallId → toolName (bounded by maxSteps per turn)
  let phase: AssistantPhase | null = null;

  const emitPhase = (next: AssistantPhase, controller: Controller): void => {
    if (next === phase) return;
    phase = next;
    controller.enqueue({ type: PHASE_PART, data: { phase: next }, transient: true });
  };

  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      try {
        const type = typeof chunk?.type === 'string' ? chunk.type : '';

        if (type === 'start') {
          controller.enqueue(chunk);
          emitPhase('thinking', controller);
          return;
        }

        if (type.startsWith('tool-')) {
          // Only the input-side chunks carry `toolName`; record it so the output-side chunks (which
          // carry only `toolCallId`) can be attributed. An unattributed chunk is dropped — fail closed.
          if ('toolName' in chunk && 'toolCallId' in chunk) {
            toolNames.set(chunk.toolCallId, chunk.toolName);
          }
          const id = 'toolCallId' in chunk ? chunk.toolCallId : undefined;
          if (id !== undefined && toolNames.get(id) === EMIT_REPORT_TOOL) {
            emitPhase('composing', controller);
            controller.enqueue(redactEmitReportOutput(chunk));
          } else {
            emitPhase('querying', controller);
          }
          return;
        }

        // Known custom data parts pass; any other data-* (unknown/future) drops.
        if (type === PHASE_PART || type === REPORT_READY_PART || PASS_TYPES.has(type)) {
          controller.enqueue(chunk);
        }
        // Everything else — reasoning-*, source-*, file, message-metadata, unknown — drops.
      } catch (error) {
        // A malformed chunk must be dropped, never thrown: a throw here bypasses the masked onError
        // line and aborts the client's stream mid-turn.
        console.error('[assistant] phase filter dropped a malformed chunk', error);
      }
    },
  });
}

// Strip emit_report's failure detail (schema echoes) before the client: mask a thrown execute's
// errorText and empty a returned `{ ok:false, errors }`; the success `{ ok:true, report }` passes.
function redactEmitReportOutput(chunk: UIMessageChunk): UIMessageChunk {
  // Mask the raw errorText of both emit_report error variants — it can echo schema/column shape.
  if (chunk.type === 'tool-output-error' || chunk.type === 'tool-input-error') {
    return { ...chunk, errorText: REPORT_FAILED_TEXT };
  }
  if (chunk.type !== 'tool-output-available') return chunk;
  const output = chunk.output;
  if (typeof output === 'object' && output !== null && 'ok' in output && output.ok === false) {
    return { ...chunk, output: { ok: false, errors: [] } };
  }
  return chunk;
}
