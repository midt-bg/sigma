// F2 — `ReportSingleFlight` Durable Object (thin durable wrapper around the SingleFlight coordinator).
//
// One instance per freshness-folded dedup key (`idFromName`), so every concurrent request for the same
// question routes to ONE isolate — upgrading the coordinator's in-isolate collapse to a cross-isolate
// single-flight. Option 2 (spec §3): the DRIVER generates in the request isolate and keeps its rich
// stream; this DO only brokers driver/waiter and wakes waiters with the driver's report.
//
// ALL decision logic lives in the pure `SingleFlight` coordinator (exhaustively unit-tested). This class
// is thin platform glue — RPC surface, the driver-crash alarm, and R2-exists — and is verified by
// typecheck + deploy, not a unit test (the repo has no Workers/DO test harness; the coordinator does the
// testable work). Keep it small enough to read-verify.
//
// A `Promise`/closure can't cross the RPC boundary, so a waiter BLOCKS inside `claimAndWait` until the
// driver settles and the DO returns a plain, structured-cloneable result.

import { DurableObject } from 'cloudflare:workers';
import { SingleFlight, type GeneratorResult } from './single-flight';
import type { DedupLayer, DedupPayload, ResolveSignals } from './dedup';

// Crash-safety alarm: how long a driver's DO may sit in the 'driver' role before the coordinator is
// reset so the NEXT request can drive. Generous (> a live driver's own budget) so a slow-but-live
// driver's eventual complete() still populates the cache; it never gates a waiter's wall-clock (that is
// WAITER_MAX_BLOCK_MS below). Fail toward regeneration.
const GENERATION_TIMEOUT_MS = 130_000;

// How long a WAITER may block awaiting the driver's report. Bounded to the driver's OWN generation budget
// (agent.ts SETTLE_BACKSTOP_MS, 60s) — NOT the 130s crash alarm: a waiter is a live Worker request, and
// Cloudflare severs a request that produces no bytes for too long (524), so a waiter that blocked the full
// 130s would be killed mid-wait with no usable result. At this cap the waiter returns 'regenerate' cleanly
// instead. Trade-off: a genuinely >60s live generation collapses fewer waiters (they regenerate rather
// than share the driver's report) — safe, at some duplicate cost. Streaming keepalive to waiters is the
// real remedy for very-slow generations (tracked follow-up); this tune just removes the silent-524 window.
const WAITER_MAX_BLOCK_MS = 60_000;

export type ClaimResult =
  | { kind: 'hit'; reportId: string; createdAt: string; layer: DedupLayer }
  | { kind: 'driver' }
  | { kind: 'ready'; reportId: string; createdAt: string }
  | { kind: 'regenerate' };

export interface ReportSingleFlightEnv {
  DEDUP_KV: KVNamespace;
  REPORTS?: R2Bucket;
}

export class ReportSingleFlight extends DurableObject<ReportSingleFlightEnv> {
  private readonly flight: SingleFlight;

  constructor(ctx: DurableObjectState, env: ReportSingleFlightEnv) {
    super(ctx, env);
    this.flight = new SingleFlight({
      kv: env.DEDUP_KV,
      r2Exists: async (reportId) => {
        if (!env.REPORTS) return false;
        return (await env.REPORTS.head(`report/${reportId}.json`)) !== null;
      },
    });
  }

  /**
   * Route entry. Live hit → serve; first miss → 'driver' (route generates, then calls complete/fail);
   * concurrent miss → block until the driver settles → 'ready', or 'regenerate' on failure/timeout.
   */
  async claimAndWait(signals: ResolveSignals, freshness: string): Promise<ClaimResult> {
    const outcome = await this.flight.claim(signals, freshness);
    if (outcome.role === 'hit') {
      return {
        kind: 'hit',
        reportId: outcome.reportId,
        createdAt: outcome.createdAt,
        layer: outcome.layer,
      };
    }
    if (outcome.role === 'driver') {
      await this.ctx.storage.setAlarm(Date.now() + GENERATION_TIMEOUT_MS);
      return { kind: 'driver' };
    }
    // Block on the driver, but never past WAITER_MAX_BLOCK_MS — race the wait against a timer so a slow or
    // crashed driver releases this waiter to regenerate well before the platform 524s the request. The
    // timer is always cleared (finally), including when the driver's report wins the race, so it can't leak.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const capped = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('waiter block exceeded')), WAITER_MAX_BLOCK_MS);
      });
      const result = await Promise.race([outcome.result, capped]);
      return { kind: 'ready', reportId: result.reportId, createdAt: result.createdAt };
    } catch {
      return { kind: 'regenerate' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Driver succeeded: cache under every layer, wake waiters, disarm the crash alarm. */
  async complete(
    recordAs: DedupPayload[],
    freshness: string,
    result: GeneratorResult,
  ): Promise<void> {
    // Wake waiters FIRST so a transient deleteAlarm() failure can't leave them blocked until the 130s crash
    // alarm. After flight.complete()'s reset() the waiter set is empty, so a stray alarm firing later is a
    // no-op fail() over zero waiters — disarming is a best-effort cleanup, not a correctness dependency.
    await this.flight.complete(recordAs, freshness, result);
    await this.ctx.storage.deleteAlarm().catch(() => {});
  }

  /** Driver failed/aborted: release waiters to regenerate, disarm the alarm. */
  async fail(): Promise<void> {
    this.flight.fail();
    await this.ctx.storage.deleteAlarm().catch(() => {});
  }

  /** Crash safety: a driver that never settled → release waiters so the next request regenerates. */
  async alarm(): Promise<void> {
    this.flight.fail(new Error('generation timed out'));
  }
}
