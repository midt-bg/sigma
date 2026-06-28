// F2 — single-flight report generation (coordinator).
//
// One generation per key, ever. Two people asking the same fixed-period question concurrently must
// collapse onto ONE generation, not race two that could diverge (a #97 violation).
//
// Scope of THIS module — in-isolate collapse: concurrent `run` calls sharing one SingleFlight
// instance join a single in-flight promise. JS is single-threaded within an isolate, so the shared
// promise IS the lock — no extra synchronisation needed. Across isolates, KV is the backstop: the
// leader `record`s its report, so a later isolate dedups on the cache hit instead of regenerating
// (eventually consistent, not a hard lock).
//
// Phase 3 (NOT in this module): a Durable Object keyed `idFromName(L2key)` will route every request
// for a key to ONE isolate, upgrading the KV backstop to a hard single-flight. That DO does not exist
// yet — this coordinator is written to drop into that wrapper unchanged. See docs/spec/ai-assistant-dedup.md §3.
//
// Freshness is taken per-run, not per-instance: the L2 key folds the freshness token (see dedup.ts),
// so a data refresh yields a different key — and, once wired, a different DO instance. We do not
// re-check freshness here; `lookup` already rejects any cache entry whose token has moved.
//
// Fail toward regeneration everywhere: a KV hit whose R2 artifact was GC'd is a miss; a generator
// throw clears the flight so the next request regenerates; a failed cache write is swallowed — and
// even then the numbers can't diverge (values are bound by reference, #97), so the worst case is a
// duplicate artifact, never a contradictory one.

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

/** Supplied by the orchestrator/chat route. Emits coarse progress; resolves to the report. */
export type Generator = (emit: (event: ProgressEvent) => void) => Promise<GeneratorResult>;

export type ProgressSubscriber = (event: ProgressEvent) => void;

export interface SingleFlightDeps {
  kv: DedupKv;
  /** True iff the report artifact still exists in R2. A GC'd artifact ⇒ treat any KV hit as a miss. */
  r2Exists: (reportId: string) => Promise<boolean>;
}

export interface ResolveOutcome {
  reportId: string;
  createdAt: string;
  /** true = served from cache (KV hit + R2 present), no generation ran. */
  deduped: boolean;
  /** Which dedup layer produced a cache hit; absent when freshly generated. */
  layer?: DedupLayer;
}

/**
 * One instance per key (intended: one per DO instance once wired — see file header). Collapses
 * concurrent `run` calls onto a single generation and rebroadcasts its coarse progress to every waiter.
 */
export class SingleFlight {
  private inFlight: Promise<ResolveOutcome> | null = null;
  private readonly subscribers = new Set<ProgressSubscriber>();
  private lastProgress: ProgressEvent | null = null;

  constructor(private readonly deps: SingleFlightDeps) {}

  /**
   * Resolve a report: serve a live cache hit, else run (or join) the single generation for this key.
   * @param recordAs the layer key the freshly generated report is cached under (typically L2/L2.5).
   * @param onProgress receives coarse progress; late waiters immediately get the last event (catch-up).
   */
  async run(
    freshness: string,
    signals: ResolveSignals,
    recordAs: DedupPayload,
    generator: Generator,
    onProgress?: ProgressSubscriber,
  ): Promise<ResolveOutcome> {
    const hit = await this.resolveLive(signals, freshness);
    if (hit) {
      return { reportId: hit.reportId, createdAt: hit.createdAt, deduped: true, layer: hit.layer };
    }

    if (onProgress) {
      this.subscribers.add(onProgress);
      if (this.lastProgress) onProgress(this.lastProgress);
    }

    // First caller becomes the leader and starts the one generation; the rest await the same promise.
    if (!this.inFlight) {
      this.inFlight = this.generate(freshness, recordAs, generator).finally(() => {
        this.inFlight = null;
        this.subscribers.clear();
        this.lastProgress = null;
      });
    }

    try {
      return await this.inFlight;
    } finally {
      if (onProgress) this.subscribers.delete(onProgress);
    }
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

  private async generate(
    freshness: string,
    recordAs: DedupPayload,
    generator: Generator,
  ): Promise<ResolveOutcome> {
    // Throws propagate to every waiter; the `.finally` above clears the flight so the next call retries.
    const result = await generator((event) => this.broadcast(event));
    await record(this.deps.kv, recordAs, freshness, result).catch(() => {
      // best-effort cache write; a lost write just causes a future miss (regeneration)
    });
    return { reportId: result.reportId, createdAt: result.createdAt, deduped: false };
  }

  private broadcast(event: ProgressEvent): void {
    this.lastProgress = event;
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        // a faulty subscriber must not break generation or starve other waiters
      }
    }
  }
}
