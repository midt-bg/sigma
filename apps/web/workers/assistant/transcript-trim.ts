// E2 — server-side trim / summarize of old turns (depends on E1).
//
// To bound the transcript the server re-reads each turn, keep the last N turns verbatim and
// collapse everything older into ONE server-side summary message. The collapse is fully
// deterministic (no LLM, no clock, no randomness): tool payloads are dropped, each older message
// becomes a one-line preview, and referenced report chips are folded into the summary's `content`.
// The summary is then HMAC-signed with the same key (E1) so it survives the next turn's
// `filterIncomingTranscript` exactly like any other server-emitted message.
//
// PRECONDITION: `messages` is expected to be the trusted output of `filterIncomingTranscript`.
// Because folding content into a *signed* summary would otherwise launder whatever it folds into
// server-authentic text, trim does not take this on faith: it independently re-verifies every
// collapsed assistant/tool message under the E1 key and against the target `conversationId`, and
// silently excludes any that is unsigned, forged, or cross-conversation. A mis-ordered pipeline
// therefore cannot bake injected text into the summary. User messages are folded verbatim but
// role-labeled ("user:") and, like all user input, are never treated as authoritative.

import {
  attachSignature,
  verifyMessage,
  type AssistantHmacEnv,
  type ReportRef,
  type TranscriptMessage,
} from './transcript-hmac';

export interface TrimOptions {
  /** Number of most-recent turns to keep verbatim. The rest collapse into one summary. */
  keepLastNTurns: number;
}

const MAX_PREVIEW_CHARS = 200;
const SUMMARY_ROLE = 'assistant' as const;

function oneLine(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_PREVIEW_CHARS
    ? `${collapsed.slice(0, MAX_PREVIEW_CHARS)}…`
    : collapsed;
}

function bySlot(a: TranscriptMessage, b: TranscriptMessage): number {
  if (a.turnIndex !== b.turnIndex) return a.turnIndex - b.turnIndex;
  return a.position - b.position;
}

function distinctTurns(messages: readonly TranscriptMessage[]): number[] {
  return [...new Set(messages.map((m) => m.turnIndex))].sort((a, b) => a - b);
}

// Deterministic, payload-free rendering of the collapsed turns.
function summaryContent(
  foldable: readonly TranscriptMessage[],
  collapsedTurnCount: number,
): string {
  const ordered = [...foldable].sort(bySlot);
  const lines = ordered.map((m) => {
    const preview = m.role === 'tool' ? '[tool резултат пропуснат]' : oneLine(m.content);
    return `${m.turnIndex}.${m.position} ${m.role}: ${preview}`;
  });

  const reports: ReportRef[] = [];
  const seenReports = new Set<string>();
  for (const m of ordered) {
    for (const ref of m.reports ?? []) {
      if (seenReports.has(ref.id)) continue;
      seenReports.add(ref.id);
      reports.push(ref);
    }
  }

  const header = `[свита история: ${collapsedTurnCount} по-стари хода]`;
  const body = lines.join('\n');
  const tail =
    reports.length > 0
      ? `\nдоклади: ${reports.map((r) => `"${r.title}" (${r.id})`).join(', ')}`
      : '';
  return `${header}\n${body}${tail}`;
}

/**
 * Keep the last `keepLastNTurns` turns verbatim; collapse all older turns into one signed summary
 * for `conversationId`. Returns `[summary, ...keptVerbatim]` when anything collapses, else the
 * messages unchanged. Only authentic, same-conversation assistant/tool messages are folded into the
 * summary (see the module precondition); user messages are folded verbatim and role-labeled.
 * Deterministic: identical input yields byte-identical output. Throws if the key is unconfigured.
 */
export async function trimTranscript(
  env: AssistantHmacEnv,
  messages: readonly TranscriptMessage[],
  conversationId: string,
  options: TrimOptions,
): Promise<TranscriptMessage[]> {
  const { keepLastNTurns } = options;
  if (!Number.isInteger(keepLastNTurns) || keepLastNTurns < 0) {
    throw new Error(`keepLastNTurns must be a non-negative integer, got ${keepLastNTurns}`);
  }
  if (messages.length === 0) return [];

  const turns = distinctTurns(messages);
  if (turns.length <= keepLastNTurns) return [...messages];

  const keptTurns = new Set(turns.slice(turns.length - keepLastNTurns));
  const collapsed = messages.filter((m) => !keptTurns.has(m.turnIndex));
  const keptVerbatim = messages.filter((m) => keptTurns.has(m.turnIndex));

  // Place the summary at the slot just after the last collapsed message so it sorts before every
  // kept turn (kept turnIndices are strictly greater than any collapsed turnIndex).
  const lastCollapsed = [...collapsed].sort(bySlot).at(-1)!;

  // Defense in depth against a mis-ordered pipeline: never fold an unauthenticated or
  // cross-conversation server-role message into the signed summary. User messages are folded
  // verbatim (role-labeled, never authoritative); assistant/tool messages must verify under the E1
  // key and belong to this conversation, else they are excluded from the fold.
  const foldable: TranscriptMessage[] = [];
  for (const message of collapsed) {
    if (message.role === 'user') {
      foldable.push(message);
      continue;
    }
    if (message.conversationId === conversationId && (await verifyMessage(env, message))) {
      foldable.push(message);
    }
  }

  // The header reflects how many turns left the verbatim window, independent of how many messages
  // survived the fold's authenticity check.
  const collapsedTurnCount = new Set(collapsed.map((m) => m.turnIndex)).size;

  const summary = await attachSignature(env, {
    role: SUMMARY_ROLE,
    content: summaryContent(foldable, collapsedTurnCount),
    conversationId,
    turnIndex: lastCollapsed.turnIndex,
    position: lastCollapsed.position + 1,
  });

  return [summary, ...keptVerbatim];
}
