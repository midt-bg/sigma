// Leak-safe, total error text for server logs.
//
// WHAT THIS GUARANTEES: the returned string is single-line, length-bounded, carries no stack and no
// `cause` chain, and — for any input listed in `redact` — no verbatim copy of that input, whether the
// echo is raw, JSON-escaped (`\"`, a literal `\n`) or truncated (any run of REDACT_WINDOW+ characters
// of the input is blanked). The function NEVER throws, which is the point: it runs inside catch
// blocks whose whole job is to degrade gracefully.
//
// WHAT IT DOES NOT GUARANTEE (read before trusting it): a provider's `message` is attacker/provider
// controlled text and CAN echo whatever we sent. Dropping the stack does not address that — stack
// frames are function names, never user text; the echo lives in the message. That is why the call
// sites that know their input pass it via `redact` (the question, the search query): redaction is
// the part that actually closes the echo, the cap and the stack-drop only bound the blast radius.
// An echo re-encoded beyond JSON escaping (`к…` ensure-ascii style, base64, a translation) is
// NOT matched — the cap then bounds it to MAX_LOG_MESSAGE_CHARS. Where the input is not known at
// the catch site (a D1 error carrying model-built SQL), the message is logged as-is by design — the
// alternative is logging nothing and losing the diagnostic. Compare workers/request-log.ts, which
// records `q_len` rather than `q` for the same reason.

// Bound the line: a provider can return a whole response body as the message, and an unbounded log
// line is its own hazard (tail cost, mid-pipeline truncation).
export const MAX_LOG_MESSAGE_CHARS = 300;

// Bound the WORK too: collapse/redact/count run over the raw message, and a multi-MB body as
// `message` is itself hostile (measured: ~250 ms for 4 MB before this cap; ~2 ms after). Generous
// enough that the final 300-code-point line is never starved by ordinary whitespace.
export const MAX_RAW_CHARS = MAX_LOG_MESSAGE_CHARS * 64;

// Below this length a "redact me" needle is too short to be safely distinguishable from ordinary
// error prose ("ЕИК", a two-word query) — blanking it would shred the message without protecting
// anything meaningful.
const MIN_REDACT_CHARS = 8;

// A needle at least this long is also matched by WINDOWS of this length, so a truncated echo (the
// embed path caps its input; a provider quotes the first N chars) is still blanked. A 24-character
// run shared between the input and genuine error prose only happens when the input itself contains
// provider prose — the cost is over-redaction of that phrase in one log line, never a leak.
const REDACT_WINDOW = 24;

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

/** Prefix of `raw` of at most `max` UTF-16 units that never ends on a lone high surrogate. */
function preCap(raw: string, max: number): string {
  if (raw.length <= max) return raw;
  const last = raw.charCodeAt(max - 1);
  return raw.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Slice by CODE POINTS, so a cap can never cut an emoji in half and emit a lone surrogate. */
function capCodePoints(text: string, max: number): string {
  if (text.length <= max) return text; // UTF-16 length ≤ max ⇒ code points ≤ max; skip the array
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max).join('')}…` : text;
}

/**
 * Blank every occurrence of `needle` in `out`. Short needles (below REDACT_WINDOW) match exactly;
 * longer ones match by sliding window, so a partial echo of a long input is blanked as one run.
 */
function redactRuns(out: string, needle: string): string {
  if (needle.length < REDACT_WINDOW) return out.split(needle).join(REDACTED);
  const windows = new Set<string>();
  for (let i = 0; i + REDACT_WINDOW <= needle.length; i += 1) {
    windows.add(needle.slice(i, i + REDACT_WINDOW));
  }
  const covered = new Uint8Array(out.length);
  let any = false;
  for (let p = 0; p + REDACT_WINDOW <= out.length; p += 1) {
    if (windows.has(out.slice(p, p + REDACT_WINDOW))) {
      covered.fill(1, p, p + REDACT_WINDOW);
      any = true;
    }
  }
  if (!any) return out;
  let res = '';
  let inRun = false;
  for (let k = 0; k < out.length; k += 1) {
    if (covered[k]) {
      if (!inRun) {
        res += REDACTED;
        inRun = true;
      }
    } else {
      res += out[k];
      inRun = false;
    }
  }
  return res;
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
  // where an echoed input would sit. Pre-capped first so the passes below are bounded work.
  let out = collapseWhitespace(preCap(raw, MAX_RAW_CHARS));
  for (const needle of redact) {
    // The typeof check keeps the function total against a non-string slipping through the `unknown`
    // boundary. Normalise the needle the same way as the message — the length floor must also be
    // judged on the collapsed form, or runs of whitespace could pad a too-short needle past it.
    if (typeof needle !== 'string') continue;
    const n = collapseWhitespace(needle);
    if (n.length < MIN_REDACT_CHARS) continue;
    // Two forms: the verbatim echo, and the JSON-escaped echo a provider emits when it puts the
    // input inside a JSON error body (`"` → `\"`, a newline → the two characters `\n`). The escaped
    // form is built from the RAW needle, because that is what the provider escaped.
    const forms = new Set([n, collapseWhitespace(JSON.stringify(needle).slice(1, -1))]);
    for (const form of forms) out = redactRuns(out, form);
  }
  return capCodePoints(out, MAX_LOG_MESSAGE_CHARS);
}

/**
 * The first `frames` stack frames — function names and locations only, never user text. Use where
 * the failure is a config/programming fault (not a provider envelope) and the frame is the actual
 * diagnostic; returns '' when the runtime supplies no stack (or no recognisable frame — a runtime
 * with a different frame syntax fails CLOSED rather than leaking the header).
 */
export function stackHead(error: unknown, frames = 3): string {
  let stack: unknown;
  try {
    if (!(error instanceof Error)) return '';
    stack = error.stack; // a getter on exotic objects — total, like errorText
  } catch {
    return '';
  }
  if (typeof stack !== 'string') return '';
  // V8 prints the FULL message — every line of a multi-line one — before the first frame, so
  // "drop line 0" is not enough: anchor on the first `    at ` line and keep only frame lines, or a
  // multi-line message would leak its continuation lines here, unredacted and uncapped.
  const lines = stack.split('\n');
  const first = lines.findIndex((line) => /^\s+at\s/.test(line));
  if (first === -1) return '';
  return lines
    .slice(first)
    .filter((line) => /^\s+at\s/.test(line))
    .slice(0, frames)
    .map((line) => line.trim())
    .join(' | ');
}
