// Bridge from a tool's D1 output to a handled, byte-capped QueryResult that the report binder
// (report-schema.ts) re-binds from. Each server-executed tool call gets a stable handle (R1, R2, …)
// the model references in emit_report. Pure — unit-testable, no deps/bindings.

import type { QueryResult } from './report-schema';
import { capRows, RESULT_BYTE_CAP } from './sql-guard';

/** Stable per-turn handle for the i-th (0-based) tool result. */
export function resultHandle(i: number): string {
  return `R${i + 1}`;
}

/**
 * Convert D1 `.all()` output (an array of row objects) into a QueryResult: columns from the row
 * keys, rows as aligned tuples, with the run_sql byte cap applied (spec §7) and truncation flagged.
 */
export function toQueryResult(
  handle: string,
  rows: Record<string, string | number | null>[],
  cap = RESULT_BYTE_CAP,
): QueryResult {
  const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
  const tuples = rows.map((r) => columns.map((c) => r[c] ?? null));
  const capped = capRows(tuples, cap);
  return { handle, columns, rows: capped.rows, truncated: capped.truncated };
}

// The model only needs a result's SHAPE + a small sample to author the report; the FULL result (up to
// RESULT_BYTE_CAP, in ctx.results) is bound SERVER-SIDE into the report — a `table` block binds by
// resultId, so it always renders every stored row regardless of what the model saw. Serialising the whole
// payload into the model's context is what overflowed the 65 536-TOKEN window on list queries: a 64 KB
// Cyrillic result ≈ 47k tokens; + the ~10k system prompt + the forced emit_report 8k output reservation
// tipped the request past the window → provider 500 "maximum context length" (see DEEPDIVE-postfix.md §1).
// So cap what the MODEL sees to a small preview, independent of what the report renders. Previewing shrinks
// only the model's view of the tail rows (its prose), never the rendered report.
export const MODEL_PREVIEW_BYTE_CAP = 8 * 1024;

/**
 * Compact, capped representation of a result for the model's context (never the full payload twice). Rows
 * are previewed to `previewCap` bytes; the head always reports the TRUE row count and flags both DB-side
 * truncation (`отрязани от базата`, from RESULT_BYTE_CAP) and preview truncation (`показани първите N`).
 */
export function forModel(r: QueryResult, previewCap = MODEL_PREVIEW_BYTE_CAP): string {
  const preview = capRows(r.rows, previewCap);
  const shown = preview.rows.length;
  const total = r.rows.length;
  const flags = [
    r.truncated ? 'отрязани от базата' : '',
    shown < total ? `показани първите ${shown}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const head = `${r.handle} (колони: ${r.columns.join(', ')}) — ${total} ред(а)${flags ? `, ${flags}` : ''}`;
  return `${head}\n${JSON.stringify(preview.rows)}`;
}
