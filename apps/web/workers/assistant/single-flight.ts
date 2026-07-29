// F2 — single-flight report generation (coordinator).
//
// One generation per key at a time. Two people asking the same fixed-period question concurrently
// collapse onto ONE generation instead of racing two.
//
// Architecture (spec §3, Option 2 — "route generates, DO brokers"): generation runs in the REQUEST
// isolate (the driver keeps its full rich stream); this coordinator only decides driver-vs-waiter,
// fans coarse progress to waiters, and wakes them with the driver's report. The `ReportSingleFlight`
// Durable Object is a thin durable wrapper that routes every request for a key to ONE instance and
// delegates to this coordinator; `alarm()` calls `fail()` if a driver never settles (crash/abort).
//
// Correctness note: single-flight here is a COST/dedup optimization, NOT the #97 no-divergence guard.
// Numeric identity across concurrent generations is guaranteed by values-by-reference binding (spec
// §5.2) — the same resolved SQL + bindReport yields identical numbers regardless of phrasing. So the
// coordinator holds in-memory state only; a rare evict-during-solo-generation degrades to a duplicate
// artifact with identical numbers (a cost blip), never a contradictory one.
//
// Fail toward regeneration everywhere: a KV hit whose R2 artifact was GC'd is a miss; a driver failure
// rejects waiters so they regenerate; a failed cache write is swallowed (worst case: a future miss).

import {
  record,
  resolveReport,
  type DedupKv,
  type DedupHit,
  type DedupLayer,
  type DedupPayload,
  type ResolveSignals,
} from './dedup';

export type ProgressPhase = 'planning' | 'querying' | 'composing' | 'binding';

export interface ProgressEvent {
  phase: ProgressPhase;
  label: string;
}

/** A finished report. `createdAt` is the generator's ISO timestamp (not read from a clock here). */
export interface GeneratorResult {
  reportId: string;
  createdAt: string;
}

export type ProgressSubscriber = (event: ProgressEvent) => void;

export interface SingleFlightDeps {
  kv: DedupKv;
  /** True iff the report artifact still exists in R2. A GC'd artifact ⇒ treat any KV hit as a miss. */
  r2Exists: (reportId: string) => Promise<boolean>;
}

/** The role this caller plays for the key, decided at claim time. */
export type ClaimOutcome =
  | { role: 'hit'; reportId: string; createdAt: string; layer: DedupLayer }
  | { role: 'driver' }
  | {
      role: 'waiter';
      /** Resolves with the driver's report; rejects if the driver fails (caller regenerates). */
      result: Promise<GeneratorResult>;
      /** Subscribe to coarse progress; the last event is delivered immediately (catch-up). */
      subscribe: (onProgress: ProgressSubscriber) => void;
    };

interface Waiter {
  resolve: (result: GeneratorResult) => void;
  reject: (error: unknown) => void;
}

/**
 * One instance per key (one per DO instance once wired — see file header). Decides driver/waiter,
 * broadcasts coarse progress, and wakes waiters with the single generation's report.
 */
export class SingleFlight {
  private generating = false;
  private readonly waiters = new Set<Waiter>();
  private readonly subscribers = new Set<ProgressSubscriber>();
  private lastProgress: ProgressEvent | null = null;

  constructor(private readonly deps: SingleFlightDeps) {}

  /**
   * Decide this caller's role. A live cache hit (KV + R2) short-circuits; otherwise the first caller is
   * the driver and later callers are waiters that await the driver's report.
   */
  async claim(signals: ResolveSignals, freshness: string): Promise<ClaimOutcome> {
    const hit = await this.resolveLive(signals, freshness);
    if (hit) {
      return { role: 'hit', reportId: hit.reportId, createdAt: hit.createdAt, layer: hit.layer };
    }
    // No `await` between reading and writing `generating` → the check-and-set is atomic within the
    // isolate, so interleaved claims yield exactly one driver.
    if (this.generating) {
      let resolve!: (result: GeneratorResult) => void;
      let reject!: (error: unknown) => void;
      const result = new Promise<GeneratorResult>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const waiter: Waiter = { resolve, reject };
      this.waiters.add(waiter);
      const subscribe = (onProgress: ProgressSubscriber) => {
        this.subscribers.add(onProgress);
        if (this.lastProgress) onProgress(this.lastProgress);
      };
      return { role: 'waiter', result, subscribe };
    }
    this.generating = true;
    return { role: 'driver' };
  }

  /** Driver → coarse progress fanned to every subscribed waiter. */
  postProgress(event: ProgressEvent): void {
    this.lastProgress = event;
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        // a faulty subscriber must not starve other waiters
      }
    }
  }

  /**
   * Driver succeeded: wake waiters, then cache the report under every supplied layer. A failed cache
   * write is swallowed (a lost write only causes a future miss → regeneration; numbers never diverge).
   *
   * Ordering matters: waiters are blocked on a live request (bounded by the DO's WAITER_MAX_BLOCK_MS),
   * so we wake them FIRST — off the cache-write critical path — then persist. Snapshot-resolve-reset
   * runs synchronously (no await), so no interleaved claim can observe a half-cleared flight. The
   * best-effort writes run in parallel and are still awaited, so a Durable Object handler keeps the
   * isolate alive until they settle.
   */
  async complete(
    recordAs: readonly DedupPayload[],
    freshness: string,
    result: GeneratorResult,
  ): Promise<void> {
    const waiters = [...this.waiters];
    this.reset();
    for (const waiter of waiters) waiter.resolve(result);
    await Promise.all(
      recordAs.map((payload) => record(this.deps.kv, payload, freshness, result).catch(() => {})),
    );
  }

  /** Driver failed/crashed/aborted: reject waiters so they regenerate, reset. */
  fail(error?: unknown): void {
    const e = error ?? new Error('generation failed');
    for (const waiter of this.waiters) waiter.reject(e);
    this.reset();
  }

  /** True while a driver holds the flight (a DO may consult this before arming/clearing its alarm). */
  get busy(): boolean {
    return this.generating;
  }

  private reset(): void {
    this.generating = false;
    this.waiters.clear();
    this.subscribers.clear();
    this.lastProgress = null;
  }

  /** A cache hit counts only if its R2 artifact still exists; any error falls toward regeneration. */
  private async resolveLive(signals: ResolveSignals, freshness: string): Promise<DedupHit | null> {
    const hit = await resolveReport(this.deps.kv, signals, freshness);
    if (!hit) return null;
    try {
      return (await this.deps.r2Exists(hit.reportId)) ? hit : null;
    } catch {
      return null;
    }
  }
}
