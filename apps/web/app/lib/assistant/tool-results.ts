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

/** Compact, capped representation of a result for the model's context (never the full payload twice). */
export function forModel(r: QueryResult): string {
  const head = `${r.handle} (колони: ${r.columns.join(', ')}) — ${r.rows.length} ред(а)${
    r.truncated ? ', отрязани' : ''
  }`;
  return `${head}\n${JSON.stringify(r.rows)}`;
}
