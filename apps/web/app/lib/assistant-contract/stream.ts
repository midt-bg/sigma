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

// The canonical user-facing sentence for a turn the assistant cannot answer precisely — no data, an
// empty completion, or a report that could not be composed. One source of truth so the system prompt
// (NO_DATA_RULE), the server fallbacks (agent.ts, stream-phase.ts), and the dock's no-answer line
// can't drift into three different wordings.
export const INSUFFICIENT_DATA_MESSAGE =
  'Не разполагам с достатъчно информация, за да отговоря прецизно на този въпрос.';

// The sibling message for TECHNICAL report failures — a thrown emit_report, a validateEmitShape
// rejection, the dock's ok:false line. Deliberately distinct from INSUFFICIENT_DATA_MESSAGE: in these
// cases the data may well exist, so claiming "insufficient data" would assert a wrong cause
// (PR #51 review). Keep the two apart.
export const REPORT_FAILED_MESSAGE = 'Справката не можа да бъде съставена. Опитайте отново.';

// The terminal report tool's name and its SDK UI-message part type (`tool-${name}`). One source of
// truth so the server filter, the agent registration, and the dock projection can't drift apart.
export const EMIT_REPORT_TOOL = 'emit_report' as const;
export const EMIT_REPORT_PART = `tool-${EMIT_REPORT_TOOL}` as const;

// ── Turn phase (backend → dock) ──────────────────────────────────────────────────────────────────
//
// The ONLY progress signal the dock receives during a turn. The backend's stream filter
// (lib/assistant/stream-phase.ts) collapses the internal tool loop — SQL assembly, raw rows,
// reconcile — into these coarse keys; no tool name, SQL, or free text ever crosses the wire.
// Emitted as a `transient` data part: delivered to useChat's onData but never added to
// message.parts, so a phase is never persisted to the transcript.

/** Closed enum of turn phases. The wire carries only the key; the dock maps it to a fixed label. */
export const ASSISTANT_PHASES = ['thinking', 'querying', 'composing'] as const;
export type AssistantPhase = (typeof ASSISTANT_PHASES)[number];

/** AI SDK custom data-part name (namespaced `data-*`), sibling of REPORT_READY_PART. */
export const PHASE_PART = 'data-phase' as const;

export interface PhaseData {
  phase: AssistantPhase;
}
export interface PhasePart {
  type: typeof PHASE_PART;
  data: PhaseData;
}

const PHASE_KEYS: ReadonlySet<string> = new Set(ASSISTANT_PHASES);

/** Unlike isReportReadyPart above, this DOES validate `data` against the closed enum: the key drives
 *  a client-side label lookup, so an unknown key must narrow to "no phase", never render raw. */
export function isPhasePart(part: { type: string; data?: unknown }): part is PhasePart {
  if (part.type !== PHASE_PART) return false;
  const data = part.data;
  if (typeof data !== 'object' || data === null || !('phase' in data)) return false;
  return typeof data.phase === 'string' && PHASE_KEYS.has(data.phase);
}
