// Pure helpers for sanitising the client-posted chat payload before it reaches the model. Kept out of
// the route module so they are unit-testable without the Worker/SDK harness.

import type { UIMessage } from 'ai';

// A part is well-formed only if it is a non-null object AND — when it is a `text` part — carries a string
// `text`. messageTextChars/latestUserText filter on `type === 'text'` and then deref `p.text.length`
// BEFORE the route's try/catch, so a `{ "type": "text" }` with no `text` (a non-null object that the
// plain object check accepted) crashes to an unhandled 500 on the public endpoint (review #80, follow-up).
function isWellFormedPart(p: unknown): boolean {
  if (!p || typeof p !== 'object') return false;
  const part = p as { type?: unknown; text?: unknown };
  if (part.type === 'text' && typeof part.text !== 'string') return false;
  return true;
}

/**
 * Select the client messages that may be sent to the model: keep only `user`/`assistant` turns, then the
 * most recent `max`. The server OWNS the system prompt (passed via streamText's `system` option) — a
 * client-supplied `system` (or `tool`) message would otherwise be converted to a model message and reach
 * BgGPT as a second system instruction, a prompt-injection amplifier the AI SDK itself warns about.
 * Filtering BEFORE the recency slice stops injected messages from evicting real turns from the window
 * (review #80, red-team R1).
 */
export function selectClientMessages(messages: unknown, max: number): UIMessage[] {
  // `messages` is UNTRUSTED client JSON: it may be a non-array, or carry items without a `parts` array.
  // Validate structurally here so downstream (messageTextChars/latestUserText/convertToModelMessages)
  // never deref `.parts` on a bad shape — otherwise a payload like {"messages":"x"} or
  // {"messages":[{"role":"user"}]} throws and surfaces as a 500 on a public endpoint (review #80).
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m): m is UIMessage => {
      if (!m || typeof m !== 'object') return false;
      const msg = m as { role?: unknown; parts?: unknown };
      // Validate the parts ELEMENTS too, not just that `parts` is an array: a null/primitive part
      // (`parts:[null]`) slips an array check but then crashes the `p.type` deref in messageTextChars /
      // latestUserText — which run BEFORE the route's try/catch — surfacing as an unhandled 500 on the
      // public endpoint (the malformed-payload class the array check alone did not fully close; #80).
      return (
        (msg.role === 'user' || msg.role === 'assistant') &&
        Array.isArray(msg.parts) &&
        msg.parts.every(isWellFormedPart)
      );
    })
    .slice(-max);
}
