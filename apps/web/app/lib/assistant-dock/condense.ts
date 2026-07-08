// Deterministic history condensation for the outbound chat POST (spec: "Trim/резюме на старите ходове",
// docs/spec/ai-assistant.md). Pure — no DOM, no LLM call. The persisted transcript is untouched; only
// the wire copy is condensed in useAssistantChat's prepareSendMessagesRequest.

import type { UIMessage } from 'ai';
import { messageText } from './AssistantMessage';
import { projectChip, reportOutputFromMessage } from './report-projection';

/** Below/at this many messages the history goes out verbatim — short chats carry no condensation risk. */
export const CONDENSE_THRESHOLD = 12;

/** How many of the most recent messages always go out verbatim (full conversational fidelity). */
export const KEEP_RECENT = 10;

/**
 * Hard cap on the recap text — far under the server's per-message MAX_MESSAGE_CHARS (64 KB) so the recap
 * can never trip the 413. When over, the OLDEST bullets are dropped first (least valuable context).
 */
export const RECAP_MAX_CHARS = 8 * 1024;

const RECAP_HEADER = 'Резюме на по-стария разговор:';

const ROLE_LABEL: Record<string, string> = {
  user: '[потребител]',
  assistant: '[асистент]',
};

/** Each bullet gist is capped so no single verbose turn dominates the recap. */
export const GIST_MAX_CHARS = 200;

// The message's visible prose (messageText: pre-tool preamble and <tool_response> echoes already
// excluded), reduced to its first line and capped — a one-line gist of the turn.
const firstLineOf = (message: UIMessage): string => {
  const line = messageText(message).split('\n', 1)[0].trim();
  return line.length > GIST_MAX_CHARS ? `${line.slice(0, GIST_MAX_CHARS).trimEnd()}…` : line;
};

// The one-line gist of a turn. An assistant turn that produced a report is best summarised by the
// report's own projection (title + lead stat — the same essence the chip shows); prose falls back to
// the first text line. Values here are re-derived server-side every turn, so the recap carrying stale
// numbers is display-context only, never authoritative (chat-input.ts trust boundary).
const gistOf = (message: UIMessage): string => {
  if (message.role === 'assistant') {
    const output = reportOutputFromMessage(message);
    if (output?.ok) {
      const chip = projectChip(output.report);
      return chip.leadStat ? `${chip.title} — ${chip.leadStat}` : chip.title;
    }
  }
  return firstLineOf(message);
};

const bulletFor = (message: UIMessage): string | null => {
  const label = ROLE_LABEL[message.role];
  if (!label) return null;
  const gist = gistOf(message);
  if (gist === '') return null;
  return `- ${label} ${gist}`;
};

/**
 * Condense the history for POSTing: at most `KEEP_RECENT` recent messages verbatim, preceded by ONE
 * synthetic assistant message that recaps every older turn as a bullet line. Meaning survives where
 * today the oldest turns are silently dropped by the count/byte trim.
 *
 * NB — interaction with §9.3 HMAC ingest (ADR-0012 §4): the recap is an UNSIGNED, client-authored
 * assistant message, so once a signing key is provisioned the server drops it on ingest (an untrusted
 * summary must never reach the model as if authoritative). It therefore only carries older-turn context
 * in dev/preview/unprovisioned deploys; in signed production a >CONDENSE_THRESHOLD thread is effectively
 * trimmed to its recent verbatim window until the server-side signed summary (E2 transcript-trim) lands.
 */
export function condenseForPost(messages: UIMessage[]): UIMessage[] {
  if (messages.length <= CONDENSE_THRESHOLD) return messages;

  const older = messages.slice(0, -KEEP_RECENT);
  const recent = messages.slice(-KEEP_RECENT);

  let bullets = older.map(bulletFor).filter((b): b is string => b !== null);
  // Enforce the recap cap by dropping oldest bullets first. `join` adds one '\n' per line incl. header.
  let length = RECAP_HEADER.length + bullets.reduce((n, b) => n + b.length + 1, 0);
  while (bullets.length > 1 && length > RECAP_MAX_CHARS) {
    length -= bullets[0].length + 1;
    bullets = bullets.slice(1);
  }
  const recap: UIMessage = {
    // Derived from the last condensed message so a retried POST reproduces the identical recap.
    id: `recap-${older[older.length - 1].id}`,
    role: 'assistant',
    parts: [{ type: 'text', text: [RECAP_HEADER, ...bullets].join('\n') }],
  } as UIMessage;

  return [recap, ...recent];
}
