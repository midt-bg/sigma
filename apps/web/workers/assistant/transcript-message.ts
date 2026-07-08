// Shared canonical mapping between an AI SDK `UIMessage` and the `TranscriptMessage` tuple that
// transcript-hmac.ts signs/verifies (ADR-0011). Used by BOTH the emit path (agent.ts / chat.tsx —
// what to sign) and the ingest path (chat.tsx — what to verify), so the derived `content` and
// `reports` MUST be byte-identical between the two. That symmetry is the make-or-break invariant:
// any divergence makes every server message fail verification and silently drop (ADR-0012). Kept
// dependency-free of the dock so it can live server-side without pulling client code into the worker.

import type { UIMessage } from 'ai';
import type { ReportRef, TranscriptMessage, AssistantRole } from './transcript-hmac';

// The HMAC + slot fields the server stamps into `UIMessage.metadata` at emit and reads back at ingest.
export interface SignedMeta {
  sig: string;
  conversationId: string;
  turnIndex: number;
  position: number;
}

const EMIT_REPORT_PART = 'tool-emit_report';
const DEDUP_PART = 'data-dedup';
// The future persist-lane chip (assistant-contract/stream.ts → REPORT_READY_PART): `{reportId, title}`
// linking to /reports/:id. It is already allowlisted through the phase filter (stream-phase.ts), so it
// reaches the client as a rendered report chip — bind it here too, or it would be an unsigned, editable
// laundering vector the moment a producer emits it. Local const (this file stays dock-dependency-free).
const REPORT_READY_PART = 'data-report-ready';

type TextPart = { type: 'text'; text: string };
const isTextPart = (p: { type: string }): p is TextPart =>
  p.type === 'text' && typeof (p as { text?: unknown }).text === 'string';

/**
 * Canonical signed `content` of a message: the concatenation of its text parts, joined by "\n". This
 * is exactly the prose the model re-reads (tool parts contribute via `reports`, not `content`), and it
 * round-trips verbatim through the client, so sign and verify derive the same string. Deterministic:
 * no trimming, no markup stripping (display-only concerns live in the dock, not the signed tuple).
 */
export function messageContent(msg: UIMessage): string {
  return (msg.parts ?? [])
    .filter(isTextPart)
    .map((p) => p.text)
    .join('\n');
}

/**
 * Report chips a message binds into its signature, in document order: a settled `emit_report` tool
 * output that persisted a `/reports/:id` (its `storedId` + report `title`), and any `data-dedup`
 * reuse part (`reportId` + `label`). Chips without a stable id are omitted — an unbound chip is not a
 * credibility-laundering target because it points nowhere. Order is the parts' order, so sign and
 * verify agree.
 */
export function messageReportRefs(msg: UIMessage): ReportRef[] {
  const refs: ReportRef[] = [];
  for (const part of msg.parts ?? []) {
    if (part.type === EMIT_REPORT_PART) {
      const out = (part as { output?: unknown }).output;
      if (isOkReportOutput(out) && typeof out.storedId === 'string') {
        refs.push({ id: out.storedId, title: reportTitle(out.report) });
      }
    } else if (part.type === DEDUP_PART) {
      const data = (part as { data?: unknown }).data;
      if (isDedupData(data)) refs.push({ id: data.reportId, title: data.label });
    } else if (part.type === REPORT_READY_PART) {
      const data = (part as { data?: unknown }).data;
      if (isReportReadyData(data)) refs.push({ id: data.reportId, title: data.title });
    }
  }
  return refs;
}

function reportTitle(report: unknown): string {
  return typeof report === 'object' &&
    report !== null &&
    typeof (report as { title?: unknown }).title === 'string'
    ? (report as { title: string }).title
    : '';
}

function isOkReportOutput(
  value: unknown,
): value is { ok: true; report: unknown; storedId?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { ok?: unknown }).ok === true &&
    'report' in value
  );
}

function isDedupData(value: unknown): value is { reportId: string; label: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.reportId === 'string' && typeof v.label === 'string';
}

function isReportReadyData(value: unknown): value is { reportId: string; title: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.reportId === 'string' && typeof v.title === 'string';
}

/**
 * The signed metadata the server stamped on this message, or null when absent/malformed. Untrusted on
 * ingest (it round-trips through same-origin-writable localStorage), so every field is shape-checked;
 * a tampered/partial `metadata` reads as null and the message is treated as unsigned (dropped).
 */
export function readSignedMeta(msg: UIMessage): SignedMeta | null {
  const meta = (msg as { metadata?: unknown }).metadata;
  if (typeof meta !== 'object' || meta === null) return null;
  const m = meta as Record<string, unknown>;
  if (
    typeof m.sig !== 'string' ||
    typeof m.conversationId !== 'string' ||
    !Number.isInteger(m.turnIndex) ||
    (m.turnIndex as number) < 0 ||
    !Number.isInteger(m.position) ||
    (m.position as number) < 0
  ) {
    return null;
  }
  return {
    sig: m.sig,
    conversationId: m.conversationId,
    turnIndex: m.turnIndex as number,
    position: m.position as number,
  };
}

const SIGNABLE_ROLES = new Set<string>(['user', 'assistant', 'tool']);

/**
 * Build the `TranscriptMessage` tuple for the VERIFY path from an inbound `UIMessage`. Slot + sig come
 * from `metadata` (untrusted); `content`/`reports` are re-derived from the parts, so a client that
 * edits the visible text but leaves the old `sig` fails verification. Returns null for a role the
 * scheme does not model (e.g. `system`) — the caller drops it rather than feeding it to the model.
 */
export function toTranscriptMessage(msg: UIMessage): TranscriptMessage | null {
  if (!SIGNABLE_ROLES.has(msg.role)) return null;
  const role = msg.role as AssistantRole;
  const content = messageContent(msg);
  const reports = messageReportRefs(msg);

  if (role === 'user') {
    // User messages are never signed; slot is irrelevant (filter keeps them unconditionally). Use a
    // fixed slot so the tuple is well-formed if a caller ever inspects it.
    return { role, content, conversationId: '', turnIndex: 0, position: 0, reports };
  }

  const meta = readSignedMeta(msg);
  if (!meta) {
    // Unsigned/malformed assistant/tool message — return a slot-less tuple so filterIncomingTranscript
    // records it as `unsigned`/`malformed-slot` rather than throwing.
    return { role, content, conversationId: '', turnIndex: -1, position: -1, reports };
  }
  return {
    role,
    content,
    conversationId: meta.conversationId,
    turnIndex: meta.turnIndex,
    position: meta.position,
    sig: meta.sig,
    reports,
  };
}
