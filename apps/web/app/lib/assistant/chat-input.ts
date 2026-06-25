// Pure helpers for sanitising the client-posted chat payload before it reaches the model. Kept out of
// the route module so they are unit-testable without the Worker/SDK harness.

import type { UIMessage } from 'ai';

/**
 * Select the client messages that may be sent to the model: keep only `user`/`assistant` turns, then the
 * most recent `max`. The server OWNS the system prompt (passed via streamText's `system` option) — a
 * client-supplied `system` (or `tool`) message would otherwise be converted to a model message and reach
 * BgGPT as a second system instruction, a prompt-injection amplifier the AI SDK itself warns about.
 * Filtering BEFORE the recency slice stops injected messages from evicting real turns from the window
 * (review #80, red-team R1).
 */
export function selectClientMessages(messages: UIMessage[] | undefined, max: number): UIMessage[] {
  return (messages ?? [])
    .filter((m): m is UIMessage => !!m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-max);
}
