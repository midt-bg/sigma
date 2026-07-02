// Assistant contract #3 — the chat stream (backend → dock).
//
// Tokens and tool-status are NOT a custom protocol: #80's `/assistant/chat` returns the Vercel
// AI SDK UIMessage stream via `result.toUIMessageStreamResponse()`, and the dock consumes it with
// `useChat` from `@ai-sdk/react`. Text deltas and tool parts (AI SDK v6: `type: 'tool-<name>'` with
// states input-streaming → input-available → output-available / output-error, carrying `input` and
// `output`) are STANDARD SDK parts — build the dock against the SDK, not a hand-rolled type.
//
// The ONLY custom addition is below: once our persist lane stores a report to R2, it streams a
// `report-ready` data part carrying the report id, which the dock renders as a clickable chip
// linking to `/reports/:id`. (#80 today returns the resolved report inline from `emit_report` with
// NO id, because the persist lane doesn't exist yet — wiring this part is our seam.)

/** AI SDK custom data-part name. Custom data parts are namespaced `data-*` and appear in an
 *  assistant message's `parts` array. */
export const REPORT_READY_PART = 'data-report-ready' as const;

export interface ReportReadyData {
  reportId: string; // → /reports/:id (the canonical, shareable, immutable URL)
  title: string; // chip label
}

/** The shape the dock matches on inside `message.parts`:
 *    { type: 'data-report-ready', data: { reportId, title } }
 *  Emit it server-side with the AI SDK stream writer once the StoredReport is persisted. */
export interface ReportReadyPart {
  type: typeof REPORT_READY_PART;
  data: ReportReadyData;
}

/** Narrowing helper for the dock. Type-tag check ONLY — this part is server-emitted and trusted, so
 *  `data` is not re-validated here (forged-transcript defenses live server-side, not in the dock). */
export function isReportReadyPart(part: { type: string }): part is ReportReadyPart {
  return part.type === REPORT_READY_PART;
}
