// Pure fixed-window request counter for the global BgGPT circuit-breaker (#135, spec §7 launch gate).
// Injected clock → deterministic + unit-testable. Held IN-MEMORY by the single-instance
// BgGptCircuitBreaker Durable Object; a rare isolate evict resets the window, letting at most one window's
// burst through — acceptable for a Denial-of-Wallet BACKSTOP that sits BEHIND the per-IP limiter and the
// already-bounded per-turn cost (maxSteps · maxOutputTokens · rows-read budget). Fixed (not sliding)
// window: one counter + one timestamp — the cheapest correct account-wide cap. The breaker "opens"
// (denies) for the remainder of a window once `limit` paid calls are admitted, and closes when it rolls.

export const WINDOW_MS = 60_000;
export const DEFAULT_GLOBAL_RPM = 120;
const MAX_GLOBAL_RPM = 100_000;

/**
 * Resolve the account-wide requests-per-minute cap from the (untrusted) `BGGPT_RATE_LIMIT_RPM` env
 * string: fall back to the default on a missing / non-numeric / < 1 value, and clamp to
 * [1, MAX_GLOBAL_RPM]. This is where #135's declared-but-unread var becomes connected + enforced.
 */
export function resolveGlobalRpm(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_GLOBAL_RPM;
  return Math.min(Math.floor(n), MAX_GLOBAL_RPM);
}

export interface RpmDecision {
  /** True → admitted (breaker closed). False → breaker open, throttle this request. */
  allowed: boolean;
  /** Requests admitted in the current window, including this one when `allowed`. */
  used: number;
  limit: number;
  /** ms until the window rolls — a Retry-After hint. 0 when allowed. */
  retryAfterMs: number;
}

export class RpmWindow {
  // −∞ so the FIRST admit always opens a fresh window at its own `now` (independent of timestamp scale),
  // rather than anchoring to an arbitrary epoch-0 window.
  private windowStart = Number.NEGATIVE_INFINITY;
  private count = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = WINDOW_MS,
  ) {}

  /**
   * Record one paid BgGPT call against the account-wide budget for the window containing `now`.
   * Denies (breaker open) once `limit` calls have been admitted in the current window.
   */
  admit(now: number): RpmDecision {
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count >= this.limit) {
      return {
        allowed: false,
        used: this.count,
        limit: this.limit,
        retryAfterMs: Math.max(0, this.windowStart + this.windowMs - now),
      };
    }
    this.count += 1;
    return { allowed: true, used: this.count, limit: this.limit, retryAfterMs: 0 };
  }
}
