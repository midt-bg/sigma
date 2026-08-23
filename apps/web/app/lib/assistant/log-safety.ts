// Leak-safe, total error text for server logs.
//
// WHAT THIS GUARANTEES: the returned string is single-line, length-bounded, carries no stack and no
// `cause` chain, and — for any input listed in `redact` — no verbatim copy of that input. The
// function NEVER throws, which is the point: it runs inside catch blocks whose whole job is to
// degrade gracefully.
//
// WHAT IT DOES NOT GUARANTEE (read before trusting it): a provider's `message` is attacker/provider
// controlled text and CAN echo whatever we sent. Dropping the stack does not address that — stack
// frames are function names, never user text; the echo lives in the message. That is why the call
// sites that know their input pass it via `redact` (the question, the search query): redaction is
// the part that actually closes the echo, the cap and the stack-drop only bound the blast radius.
// Where the input is not known at the catch site (a D1 error carrying model-built SQL), the message
// is logged as-is by design — the alternative is logging nothing and losing the diagnostic.
// Compare workers/request-log.ts, which records `q_len` rather than `q` for the same reason.

// Bound the line: a provider can return a whole response body as the message, and an unbounded log
// line is its own hazard (tail cost, mid-pipeline truncation).
export const MAX_LOG_MESSAGE_CHARS = 300;

// Below this length a "redact me" needle is too short to be safely distinguishable from ordinary
// error prose ("ЕИК", a two-word query) — blanking it would shred the message without protecting
// anything meaningful.
const MIN_REDACT_CHARS = 8;

const REDACTED = '«редактирано»';
const UNPRINTABLE = '«грешка без текстово представяне»';

/**
 * One line, single spaces, no edge whitespace. Applied to BOTH the message and every `redact`
 * needle: the needle comes from the composer (shift-enter newlines, tabs, double spaces) and the
 * message is collapsed before matching, so an un-collapsed needle would silently stop matching the
 * very echo it is meant to blank.
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Slice by CODE POINTS, so a cap can never cut an emoji in half and emit a lone surrogate. */
function capCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max).join('')}…` : text;
}

/**
 * The loggable text of an unknown thrown value: single-line, ≤ MAX_LOG_MESSAGE_CHARS code points,
 * with every sufficiently long `redact` entry replaced. Never the stack, never the `cause` chain,
 * never the raw object — and never a throw: a null-prototype or Proxy-wrapped throw that cannot be
 * stringified degrades to a fixed tag instead of escaping the caller's catch block.
 */
export function errorText(error: unknown, redact: readonly string[] = []): string {
  let raw: string;
  try {
    // `.message` is a getter on exotic objects and `String()` invokes toString/Symbol.toPrimitive —
    // both can throw (verified: `String(Object.create(null))` throws TypeError).
    raw = error instanceof Error ? String(error.message) : String(error);
  } catch {
    return UNPRINTABLE;
  }
  // One line per event: a multi-line message would emit continuation lines without the `[assistant]`
  // prefix, so prefix-keyed greps/alerts (and any downstream redaction) would miss exactly the tail
  // where an echoed input would sit.
  let out = collapseWhitespace(raw);
  for (const needle of redact) {
    // Normalise the needle the same way as the message — the length floor must also be judged on
    // the collapsed form, or runs of whitespace could pad a too-short needle past it. The typeof
    // check keeps the function total against a non-string slipping through the `unknown` boundary.
    const n = typeof needle === 'string' ? collapseWhitespace(needle) : '';
    if (n.length >= MIN_REDACT_CHARS) out = out.split(n).join(REDACTED);
  }
  return capCodePoints(out, MAX_LOG_MESSAGE_CHARS);
}

/**
 * The first `frames` stack frames — function names and locations only, never user text. Use where
 * the failure is a config/programming fault (not a provider envelope) and the frame is the actual
 * diagnostic; returns '' when the runtime supplies no stack.
 */
export function stackHead(error: unknown, frames = 3): string {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return '';
  return error.stack
    .split('\n')
    .slice(1, 1 + frames) // drop line 0 — it repeats the message, which errorText already handled
    .map((line) => line.trim())
    .join(' | ');
}
