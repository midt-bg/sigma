// Pure request-shaping for the report dedup lane (F): turn one chat turn's identity + resolved temporal
// bounds into the dedup signals, the record payloads, and a stable single-flight key. Kept out of the
// route so the correctness-critical decision — restrict L1 to an explicitly-resolved, SETTLED period (fold
// its absolute bounds in; skip everything else) — is unit-testable without the Worker/DO harness.

import { normalizeText, type DedupPayload, type ResolveSignals } from './dedup';

/**
 * Escape the single-flight DO-name field delimiter so distinct (prompt, filterContext) tuples can never
 * alias one DO instance. `\`→`\\` then `|`→`\|` is a classic reversible (hence injective) escaping: an
 * escaped field contains no bare `|`, so the `|` field separators stay unambiguous. Cheap synchronous
 * parity with the KV key's length-prefixed encodeFields, sufficient for a DO name (no hash needed).
 */
const escapeDoField = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

/** Minimal structural view of a resolved period — `sinceIso`..`untilIso` (half-open), both YYYY-MM-DD. */
export interface PeriodBounds {
  sinceIso: string;
  untilIso: string;
}

/**
 * Canonical L1 filter context. Folds the RESOLVED absolute period bounds (not the phrase) so the same
 * question in two different months keys to two different reports — the concrete #97 fix. An optional
 * FE-supplied filter (facets from the page the dock was opened on) is appended. Empty string when neither
 * is present (L1 then keys on the prompt alone).
 */
export function canonicalFilterContext(
  period: PeriodBounds | undefined,
  filterContext: string | undefined,
): string {
  const parts: string[] = [];
  if (period) parts.push(`p:${period.sinceIso}..${period.untilIso}`);
  const fc = filterContext?.trim();
  if (fc) parts.push(`f:${fc}`);
  return parts.join('|');
}

export interface DedupRequestInput {
  /** FE idempotency id for this submission (L0). Absent until the dock sends it (3c). */
  clientRequestId?: string;
  /** The server-authoritative user question (bounded upstream). */
  prompt: string;
  /**
   * The resolved primary period bounds — REQUIRED for L1. `undefined` means temporal.ts pinned no period
   * (all-time / no date phrase, or a relative phrase it couldn't resolve): the answer then spans the
   * still-growing present, so L1 is skipped and the turn regenerates (falls through to L0-if-present).
   */
  period?: PeriodBounds;
  /**
   * The resolved period is still SETTLING — its (exclusive) end is recent enough that its data is still
   * mutating (an open/current period like „2026" mid-year, or a just-closed one still in ingest lag).
   * Set by the route as `stableBounds === false` (ADR-0010): true unless the period has explicit, absolute,
   * un-clamped bounds. When set we skip L1: the freshness token (a single global
   * `home_totals.refreshed_at`) does NOT invalidate within a data epoch (route comment: "data changes
   * before refreshed_at updates → a stale serve"), so an L1 hit would serve a report that under-counts a
   * NAMED partial period. A fully-settled period (e.g. „2025" asked in 2026) is `false` → safe to dedup.
   */
  periodSettling?: boolean;
  /** FE-supplied facet context (3c); folded into L1. */
  filterContext?: string;
  /** The current freshness token (data + build) — folded into the single-flight key. */
  freshness: string;
}

export interface DedupRequest {
  /** Signals for `resolveReport` (pre-generation lookup). */
  signals: ResolveSignals;
  /** Layers to record when the driver's generation settles. */
  payloads: DedupPayload[];
  /** Stable single-flight instance name; `null` ⇒ no safe key ⇒ skip dedup (generate uncoordinated). */
  doName: string | null;
}

/** Shape the dedup signals, record payloads, and single-flight key for one chat turn. Pure. */
export function buildDedupRequest(input: DedupRequestInput): DedupRequest {
  const signals: ResolveSignals = {};
  const payloads: DedupPayload[] = [];

  if (input.clientRequestId) {
    signals.clientRequestId = input.clientRequestId;
    payloads.push({ layer: 'L0', clientRequestId: input.clientRequestId });
  }

  // L1 (cross-time report reuse) is safe ONLY when the answer is stable: a non-empty prompt AND an
  // explicitly-resolved period (`input.period`) whose data is no longer settling. Everything else skips
  // L1 and regenerates each turn (falling through to L0-if-present):
  //   • no period at all — all-time / no date phrase / an unresolvable relative phrase (#97). The answer
  //     spans the still-growing present, and the global freshness token does NOT invalidate within a data
  //     epoch, so an L1 hit could serve a stale under-count.
  //   • a settling period („за 2026" mid-year) — same within-epoch staleness, on a NAMED partial window.
  // A fully-settled period („2025" asked in 2026) is the one safe case. Skipping only ever costs a
  // regenerate, never a wrong answer (fail toward regeneration).
  const l1Safe =
    input.prompt.trim().length > 0 && input.period !== undefined && !input.periodSettling;
  let filterContext = '';
  if (l1Safe) {
    filterContext = canonicalFilterContext(input.period, input.filterContext);
    // Pass the RAW prompt: dedup.ts normalises it identically at hash time for both lookup and record.
    signals.prompt = input.prompt;
    signals.filterContext = filterContext;
    payloads.push({ layer: 'L1', prompt: input.prompt, filterContext });
  }

  // Single-flight instance name: strongest stable key available. L1 (freshness+prompt+context) collapses
  // concurrent identical questions; else L0 (submission idempotency); else no safe key → skip dedup.
  let doName: string | null = null;
  if (l1Safe) {
    // normalizeText the filterContext too, matching dedupKey's canonicalFields — else trivially-different
    // whitespace routes identical requests to different DO instances (missed collapse; a cost blip only).
    // ESCAPE the delimiter: normalizeText does NOT strip '|', and both prompt and filterContext are
    // free-ish text, so a raw '|'-join is non-injective — `a|b`+`c` would alias `a`+`b|c` onto ONE DO
    // instance, and on a concurrent miss the waiter is woken with the driver's DIFFERENT report (the one
    // thing this cache must never do). Escaping `\`→`\\` then `|`→`\|` makes the join injective — the
    // same guarantee the KV key gets from encodeFields's length-prefix, without an async hash for a DO name.
    doName = `L1|${input.freshness}|${escapeDoField(normalizeText(input.prompt))}|${escapeDoField(
      normalizeText(filterContext),
    )}`;
  } else if (input.clientRequestId) {
    // L0 is injective as-is: freshness is fixed-arity (`d:<alnum>|c:<alnum>`) and clientRequestId is
    // charset-validated (^[A-Za-z0-9_-]{1,100}$, no '|'), so the split is unambiguous.
    doName = `L0|${input.freshness}|${input.clientRequestId}`;
  }

  return { signals, payloads, doName };
}
