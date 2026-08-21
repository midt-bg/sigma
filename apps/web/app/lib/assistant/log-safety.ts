// Leak-safe error text for server logs.
//
// WHY: every assistant error path can carry the user's question. A Workers AI / Vectorize error may
// echo the embedded input; a D1 error may echo the SQL the model built from the question; a BgGPT
// stream error may carry the prompt. Logging the raw error OBJECT hands all of that (message, stack,
// `cause` chain, provider response body) to the log sink, which is exactly what request-log.ts
// avoids by recording `q_len` instead of `q` (review f/u on #321, lyubomir-bozhinov).
//
// One helper, used at every catch in the assistant module, so the rule is enforced in a single place
// instead of a ternary copy-pasted per call site — a missed copy is how this pattern drifts.

// Bound the line: a provider can return a very long body as the message, and an unbounded log line
// is its own hazard (cost + truncation in the middle of an aggregation pipeline).
export const MAX_LOG_MESSAGE_CHARS = 300;

/**
 * The loggable text of an unknown thrown value: its `message` for an Error, its string form
 * otherwise, capped to MAX_LOG_MESSAGE_CHARS. Never the stack, never the `cause` chain, never the
 * object itself.
 */
export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length > MAX_LOG_MESSAGE_CHARS ? `${raw.slice(0, MAX_LOG_MESSAGE_CHARS)}…` : raw;
}
