// Pure helpers for sanitising the client-posted chat payload before it reaches the model. Kept out of
// the route module so they are unit-testable without the Worker/SDK harness.

import type { UIMessage } from 'ai';

// The well-formed TEXT parts of a message, in order. Only a `text` part carrying a string `text` survives.
// The server OWNS tool execution and value binding (ctx.results is rebuilt per turn), so a client-supplied
// assistant `tool-*` part — a fabricated `tool-emit_report` output carrying made-up numbers, or a
// `tool-result` — must never reach the model as history. Reducing each message to its text parts drops
// those tool/file/data parts AND any malformed part (a `{ "type": "text" }` with no string `text` simply
// does not survive), so messageTextChars/latestUserText/convertToModelMessages only ever see clean text
// downstream (review #80, follow-up).
function textParts(parts: unknown): { type: 'text'; text: string }[] {
  if (!Array.isArray(parts)) return [];
  return parts.filter(
    (p): p is { type: 'text'; text: string } =>
      !!p &&
      typeof p === 'object' &&
      (p as { type?: unknown }).type === 'text' &&
      typeof (p as { text?: unknown }).text === 'string',
  );
}

/**
 * Select + sanitise the client messages that may be sent to the model: keep only `user`/`assistant` turns
 * reduced to their text parts, then the most recent `max`. Two boundaries, both because the server owns the
 * trusted state:
 *   1. Role — a client-supplied `system`/`tool` message is dropped; otherwise it converts to a model
 *      message and reaches BgGPT as a second system instruction, a prompt-injection amplifier the AI SDK
 *      itself warns about (review #80, red-team R1).
 *   2. Parts — each kept message is reduced to its TEXT parts (textParts). The chat is a stateless control
 *      plane; the server re-executes tools and rebinds values per turn (ctx.results), so a client must not
 *      smuggle an assistant `tool-emit_report` output (a fabricated report/numbers) or a `tool-result` into
 *      the model's history. Text is the only conversational context the model needs (review #80, follow-up).
 *
 * Filtering/reduction run BEFORE the recency slice so an injected or now-empty message cannot evict a real
 * turn from the window. A message left with no text part is dropped — which also closes the malformed-payload
 * shapes that once 500'd the route (non-array `messages`, missing/`null`/primitive parts simply yield nothing).
 */
export function selectClientMessages(messages: unknown, max: number): UIMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .flatMap((m) => {
      if (!m || typeof m !== 'object') return [];
      const msg = m as { role?: unknown; parts?: unknown };
      if (msg.role !== 'user' && msg.role !== 'assistant') return [];
      const parts = textParts(msg.parts);
      if (parts.length === 0) return [];
      return [{ ...(m as UIMessage), parts } as UIMessage];
    })
    .slice(-max);
}
