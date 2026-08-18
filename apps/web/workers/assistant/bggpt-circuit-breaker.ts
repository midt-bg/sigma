// #135 — `BgGptCircuitBreaker` Durable Object: the account-wide RPM cap in front of the paid BgGPT model
// call (spec §7 launch gate). The per-IP limiter (ASSISTANT_RATE_LIMITER, 10/min/IP) can't stop a
// distributed Denial-of-Wallet across many IPs; this single global instance (`idFromName('global')`)
// counts every PAID turn and opens the breaker once the account-wide budget for the minute is spent.
//
// Thin platform glue, like ReportSingleFlight: ALL logic lives in the pure `RpmWindow` (unit-tested); this
// class only routes every caller to one isolate and reads the clock. In-memory window (no storage/alarm) —
// a rare evict resets it, letting at most one window's burst through, acceptable for a backstop that sits
// behind the per-IP limiter + bounded per-turn cost. The limit is sourced from BGGPT_RATE_LIMIT_RPM at
// construction, so #135's declared-but-unread var is now connected and enforced.

import { DurableObject } from 'cloudflare:workers';
import { RpmWindow, resolveGlobalRpm, type RpmDecision } from './rpm-window';

export interface BgGptCircuitBreakerEnv {
  BGGPT_RATE_LIMIT_RPM?: string;
}

export class BgGptCircuitBreaker extends DurableObject<BgGptCircuitBreakerEnv> {
  private readonly window: RpmWindow;

  constructor(ctx: DurableObjectState, env: BgGptCircuitBreakerEnv) {
    super(ctx, env);
    this.window = new RpmWindow(resolveGlobalRpm(env.BGGPT_RATE_LIMIT_RPM));
  }

  /** Record one paid BgGPT call against the global window; deny (breaker open) once the minute saturates. */
  async admit(): Promise<RpmDecision> {
    return this.window.admit(Date.now());
  }
}
