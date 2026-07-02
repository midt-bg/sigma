// F3 — dedup & progress stream parts (producer + contract).
//
// Mirrors the `data-report-ready` part contract (assistant-contract/stream.ts) so the
// dock consumes all three the same way: AI SDK v6 custom data parts of the form
// `{ type: 'data-<name>', data: {...} }`, filtered out of `message.parts` by a guard.
//
// Producer-side adapters turn F2 single-flight outcomes into wire parts; this module is
// the single source of truth for the Bulgarian user-facing copy. When the seam converges,
// the *_PART / *Data / *Part / is*Part surface graduates verbatim into assistant-contract.
import type { DedupLayer } from './dedup';
import type { ProgressEvent, ProgressPhase, ResolveOutcome } from './single-flight';

export const DEDUP_PART = 'data-dedup' as const;
export const PROGRESS_PART = 'data-progress' as const;

/**
 * Emitted once when a request is served from an existing report instead of being
 * regenerated. `layer` is the dedup layer that hit (telemetry / debugging); `label`
 * is ready-to-render Bulgarian copy.
 *   { type: 'data-dedup', data: { reportId, createdAt, layer, label } }
 */
export interface DedupData {
  reportId: string;
  createdAt: string;
  layer: DedupLayer;
  label: string;
}

/**
 * Coarse progress for waiters collapsed onto an in-flight generation.
 *   { type: 'data-progress', data: { phase, label } }
 */
export interface ProgressData {
  phase: ProgressPhase;
  label: string;
}

export interface DedupPart {
  type: typeof DEDUP_PART;
  data: DedupData;
}

export interface ProgressPart {
  type: typeof PROGRESS_PART;
  data: ProgressData;
}

// Canonical user-facing copy. Centralised here so producer and dock never diverge.
export const DEDUP_LABEL_BG = 'Преизползване на съществуващ отчет';

export const PROGRESS_LABELS_BG: Record<ProgressPhase, string> = {
  planning: 'Планиране на отчета…',
  querying: 'Извличане на данните…',
  composing: 'Съставяне на отчета…',
  binding: 'Свързване на стойностите…',
};

/**
 * Map an F2 resolve outcome to a `data-dedup` part. Returns `null` when the report was
 * freshly generated (nothing to signal) or when the outcome lacks a layer to attribute.
 */
export function dedupPart(outcome: ResolveOutcome): DedupPart | null {
  if (!outcome.deduped || outcome.layer === undefined) return null;
  return {
    type: DEDUP_PART,
    data: {
      reportId: outcome.reportId,
      createdAt: outcome.createdAt,
      layer: outcome.layer,
      label: DEDUP_LABEL_BG,
    },
  };
}

/**
 * Map an F2 progress event to a `data-progress` part, stamping the canonical Bulgarian
 * label for the phase. The event's own `label` is internal/diagnostic and is not rendered.
 */
export function progressPart(event: ProgressEvent): ProgressPart {
  return {
    type: PROGRESS_PART,
    data: {
      phase: event.phase,
      label: PROGRESS_LABELS_BG[event.phase],
    },
  };
}

export function isDedupPart(part: { type: string }): part is DedupPart {
  return part.type === DEDUP_PART;
}

export function isProgressPart(part: { type: string }): part is ProgressPart {
  return part.type === PROGRESS_PART;
}
