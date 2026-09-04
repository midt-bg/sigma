import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  acquireRefreshLease,
  createTransientStaging,
  dropTransientStaging,
  loadFxRates,
  pendingTouchedRows,
  pendingWindows,
  recordPendingWindow,
  refreshDerivedContractCount,
  refreshSliceStatementGroups,
  releaseRefreshLease,
  renewRefreshLease,
  runRefreshSliceStatementGroup,
  settlePendingWindows,
} from '@sigma/ingest';
import refreshSliceSql from '../../../scripts/refresh-slice.sql';
import workStagingSchemaSql from '../../../scripts/work-staging-schema.sql';
import { computeWorkerCatchupPlan, ingestBucketWindow, type CatchupPlan } from './eop';
import { runServedIntegrityGate } from './integrity';

export interface Env {
  DB: D1Database;
  REFRESH: Workflow;
  EOP_OPEN_DATA_BASE_URL?: string;
}

interface RefreshParams {
  /** Operator override for tests/manual runs. Normal cron uses UTC today. */
  today?: string;
  /** Small overlap to re-read already loaded bucket days; default is 3. */
  lookbackDays?: number;
  /** Safety cap for Worker steady-state runs; large gaps belong to the CLI catch-up. */
  maxWindowDays?: number;
}

interface RefreshResult {
  from: string;
  to: string;
  maxLoadedDate: string | null;
  gapDays: number;
  capped: boolean;
  days: number;
  staged: number;
  derived: number;
  /** Touched-set rows an earlier aborted run left behind, recomputed by this run (0 when none). */
  pendingTouched: number;
  /** The oldest unsettled promise this run tried to replay (folded into `from`), or null. */
  replayFrom: string | null;
  /** Promises still outstanding after this run — what the cap kept out of reach (0 when none). */
  uncoveredWindows: number;
  /** Set when the run did nothing because another live instance holds the refresh lease. */
  skipped?: 'lease-held';
  /** The instance that held the lease when this run stepped aside. */
  leaseHolder?: string;
}

function stagedRows(results: Awaited<ReturnType<typeof ingestBucketWindow>>): number {
  return results.reduce(
    (n, r) =>
      n +
      r.baseContracts +
      r.baseTenders +
      r.baseAmendments +
      r.ocdsContracts +
      r.ocdsAmendments +
      r.parties +
      r.lots,
    0,
  );
}

// The on-platform daily refresh reads storage.eop.bg buckets directly. It is intentionally a small
// steady-state job: if D1 is many days behind, the Workflow caps to a recent window and logs a
// warning; the large first-run/backfill catch-up is the CLI's job to avoid D1/CPU/subrequest limits.
// The shared base and OCDS mappers keep the Worker refresh aligned with the CLI path.
export class RefreshWorkflow extends WorkflowEntrypoint<Env, RefreshParams> {
  override async run(
    event: WorkflowEvent<RefreshParams>,
    step: WorkflowStep,
  ): Promise<RefreshResult> {
    const params = event.payload ?? {};
    const fetchedAt = new Date().toISOString();

    // One writer at a time on the served D1. Every scratch table below is shared, and since the
    // touched sets outlive a run, an overlapping run's cleanup could drop the ids this run just
    // recorded. A held lease is a benign skip (the cron will come back), logged loudly; it expires so
    // a hung instance cannot fence the cron out, and it is released in the finally below.
    const leaseHolder = event.instanceId;
    const lease = await step.do('acquire-refresh-lease', async () =>
      acquireRefreshLease(this.env.DB, leaseHolder, new Date(fetchedAt)),
    );
    if (!lease.acquired) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'etl_refresh_lease_held',
          fetchedAt,
          holder: lease.holder,
          expiresAt: lease.expiresAt,
        }),
      );
      const today = params.today ?? fetchedAt.slice(0, 10);
      return {
        from: today,
        to: today,
        maxLoadedDate: null,
        gapDays: 0,
        capped: false,
        days: 0,
        staged: 0,
        derived: 0,
        pendingTouched: 0,
        replayFrom: null,

        uncoveredWindows: 0,
        skipped: 'lease-held',
        leaseHolder: lease.holder ?? undefined,
      };
    }
    // Every step that WRITES runs behind the fence: renew the lease, and if it is no longer ours,
    // stop before touching anything. Workflows resume a run from cached step results after retries
    // that can outlast the TTL, so "acquired" at step one proves nothing at step twenty — the data
    // path may belong to a newer instance by then. Losing the lease is final for this run.
    const fenced = <T extends Rpc.Serializable<T>>(
      name: string,
      fn: () => Promise<T>,
    ): Promise<T> =>
      step.do(name, async () => {
        const held = await renewRefreshLease(this.env.DB, leaseHolder, new Date());
        if (!held.acquired) {
          throw new NonRetryableError(
            `refresh lease lost before ${name}: now held by ${held.holder ?? 'nobody'}`,
          );
        }
        return fn();
      });
    let results: Awaited<ReturnType<typeof ingestBucketWindow>> = [];
    let staged = 0;
    let derived = 0;
    // The runtime logs an error ("...your Worker's code had hung...") on every *successful* instance
    // of this Workflow, at the instant run() returns - measured across runs of 5 and 30 steps, see
    // docs/etl.md. "No errors in the dashboard" is therefore not a health signal here, so a refresh
    // that actually finished has to say so itself. Logged from the finally, after the staging drop,
    // so it only ever claims success for a run that survived its own cleanup.
    let outcome: RefreshResult | null = null;
    // The run's own failure, kept so a failure inside `finally` cannot mask it: JavaScript lets a
    // throwing finally REPLACE the original error, and the gate's verdict must never be hidden
    // behind a staging-drop hiccup.
    let failed = false;
    let failure: unknown = null;
    let dropFailed = false;
    let dropFailure: unknown = null;

    try {
      await fenced('drop-stale-transient-staging', async () => dropTransientStaging(this.env.DB));

      // Every window an earlier run started and never settled is replayed: the plan loads the hull
      // of those promises and its own window (before the cap), so every group re-derives them from
      // one consistent staging of the raw rows — the touched sets recover the rollups of an aborted
      // run, but only a replay makes its half-applied window consistent again (pendingWindows).
      const unsettled = await step.do('pending-window', async () => pendingWindows(this.env.DB));
      const plan = await step.do('plan-catchup', async () =>
        computeWorkerCatchupPlan(this.env.DB, {
          today: params.today,
          lookbackDays: params.lookbackDays,
          maxWindowDays: params.maxWindowDays,
          replay: unsettled.map((w) => ({ from: w.from, to: w.to })),
        }),
      );
      if (unsettled.length > 0) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'etl_refresh_replay_window',
            unsettled,
            from: plan.from,
            to: plan.to,
            capped: plan.capped,
          }),
        );
      }
      // Recorded BEFORE anything is staged: the EXACT coverage this run applies (the capped range,
      // never the hull it was planned from), settled only after the served gate passed. Earlier
      // promises are left as they are — they shrink only by verified coverage, never by a merge.
      await fenced('record-window', async () =>
        recordPendingWindow(this.env.DB, leaseHolder, plan.from, plan.to, new Date()),
      );

      if ((plan as CatchupPlan).capped) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'etl_window_capped',
            maxLoadedDate: plan.maxLoadedDate,
            originalFrom: plan.originalFrom,
            originalGapDays: plan.originalGapDays,
            from: plan.from,
            to: plan.to,
            gapDays: plan.gapDays,
          }),
        );
      }

      await fenced('create-transient-staging', async () =>
        createTransientStaging(this.env.DB, workStagingSchemaSql),
      );
      results = await fenced('ingest-storage-eop-bucket', async () =>
        ingestBucketWindow(this.env.DB, plan, {
          baseUrl: this.env.EOP_OPEN_DATA_BASE_URL,
          fetchedAt,
        }),
      );
      staged = stagedRows(results);

      // Work an earlier run left behind: the touched sets survive an abort (refresh-slice.sql keeps
      // them until its `cleanup` batch, after the rollups), so a run that died between `contracts`
      // and the rollups has left ids whose rollups are still stale. An empty window used to
      // short-circuit right here and leave them stale until some later window happened to touch
      // the same entities; now an empty window only skips the derive when there is nothing pending.
      const pending = await step.do('pending-touched', async () => pendingTouchedRows(this.env.DB));
      // The short-circuit is for a run that has nothing to do AND owes nothing: a promise left by
      // an earlier run is never certified by "nothing staged today" — that run's work may be
      // half-applied or never verified (its derive can finish and its gate still fail), so the
      // derive and the gate run over whatever this window holds, and only they may clear the record.
      if (staged === 0 && pending.total === 0 && unsettled.length === 0) {
        console.warn(JSON.stringify({ level: 'warn', event: 'etl_zero_ingest', fetchedAt, plan }));
        // Nothing staged, nothing pending, nothing inherited: this run's own window held no data,
        // and its own promise is settled by its own (empty) coverage.
        await fenced('settle-windows-empty', async () =>
          settlePendingWindows(this.env.DB, { from: plan.from, to: plan.to }, new Date()),
        );
        outcome = {
          ...plan,
          days: results.length,
          staged: 0,
          derived: 0,
          pendingTouched: 0,
          uncoveredWindows: 0,
        };
        return outcome;
      }
      if (staged === 0) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'etl_zero_ingest_pending_touched',
            fetchedAt,
            plan,
            pending,
          }),
        );
      }

      // FX rates BEFORE the derive (#158): the CLI paths run scripts/load-fx.mjs first, but this
      // cron path never did — foreign-currency contracts staged here derived with a NULL
      // amount_eur and silently dropped out of every rollup. loadFxRates fetches only actual
      // coverage gaps (idempotent upsert into fx_rates) and throws — failing the run loudly —
      // when rates that plausibly exist could not be loaded.
      await fenced('load-fx', async () => {
        const fx = await loadFxRates(this.env.DB, { fetchedAt });
        console.log(
          JSON.stringify({
            level: 'info',
            event: 'etl_fx_load',
            inserted: fx.inserted,
            fetched: fx.fetched,
            skipped: fx.skipped,
          }),
        );
        if (fx.warnings.length > 0 || fx.uncovered.length > 0) {
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'etl_fx_uncovered',
              uncovered: fx.uncovered,
              warnings: fx.warnings,
            }),
          );
        }
        return { inserted: fx.inserted, uncovered: fx.uncovered.length };
      });

      for (const group of refreshSliceStatementGroups(refreshSliceSql)) {
        await fenced(`derive-slice:${group.name}`, async () => {
          const startedAt = Date.now();
          await runRefreshSliceStatementGroup(this.env.DB, group);
          console.log(
            JSON.stringify({
              level: 'info',
              event: 'etl_derive_slice_batch',
              batch: group.name,
              statements: group.statements.length,
              elapsedMs: Date.now() - startedAt,
            }),
          );
        });
      }
      derived = await fenced('derive-slice:count', async () =>
        refreshDerivedContractCount(this.env.DB),
      );

      // Reconciliation gate (#97) on the served D1 the refresh just wrote — the CLI paths gate every
      // derive, but this steady-state path did not. POST-COMMIT alarm: the slice is already applied
      // and served, so a violation fails the step + surfaces in observability, it does not un-serve
      // the drift (ship-and-alert; see issue #154 and docs/integrity-gate.md).
      await fenced('integrity-gate', async () => {
        try {
          await runServedIntegrityGate(this.env.DB, {
            info: (e) => console.log(JSON.stringify({ level: 'info', ...e })),
            warn: (e) => console.warn(JSON.stringify({ level: 'warn', ...e })),
            error: (e) => console.error(JSON.stringify({ level: 'error', ...e })),
          });
        } catch (err) {
          // The verdict is deterministic over the just-written rows — fail the step immediately
          // rather than burning the default (~3) retries re-checking the same committed data. A
          // transient infra error lands here too; for a verification gate, "couldn't verify → fail
          // closed" is the safe default.
          throw new NonRetryableError(err instanceof Error ? err.message : String(err));
        }
      });

      // The verified coverage is subtracted from every promise: fulfilled ones go, straddling ones
      // shrink to what is still outstanding, out-of-reach ones stay — and are named, run after run,
      // until an operator covers them (docs/etl.md, „needs-catchup").
      // An EARLIER run's promise is settled only by a run that actually saw a bucket in its window:
      // storage.eop.bg answers 403/404 for a day with no bucket (a missing day is 403 AccessDenied,
      // verified), so "nothing staged" cannot tell a quiet window from a source that answered
      // nothing at all — and only the latter must keep the promise. A run that found at least one
      // bucket has proven the source answers; its absent days are genuinely empty. This run's own
      // promise is its own window and settles regardless (an empty own window is simply done).
      const sawData = results.some((r) => r.found);
      const heldBack = sawData ? [] : unsettled;
      if (heldBack.length > 0) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'etl_refresh_replay_unverified',
            unsettled: heldBack,
            reason:
              'no bucket found in this window — the source answered nothing, so earlier promises stay',
          }),
        );
      }
      const windows = await fenced('settle-windows', async () =>
        settlePendingWindows(
          this.env.DB,
          { from: plan.from, to: plan.to },
          new Date(),
          sawData ? () => true : (w) => w.holder === leaseHolder,
        ),
      );
      if (windows.remaining.length > 0) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'etl_refresh_window_uncovered',
            uncovered: windows.remaining,
            covered: { from: plan.from, to: plan.to },
          }),
        );
      }
      outcome = {
        ...plan,
        days: results.length,
        staged,
        derived,
        pendingTouched: pending.total,
        uncoveredWindows: windows.remaining.length,
      };
      return outcome;
    } catch (err) {
      failed = true;
      failure = err;
      throw err;
    } finally {
      try {
        // The staging tables are ours to drop only while the lease is ours: if a newer instance took
        // it over, they are ITS tables now. A lost lease here is logged, not thrown — the run has
        // already failed or finished, and the release below must still happen.
        await step.do('drop-transient-staging', async () => {
          const held = await renewRefreshLease(this.env.DB, leaseHolder, new Date());
          if (!held.acquired) {
            console.warn(
              JSON.stringify({
                level: 'warn',
                event: 'etl_refresh_staging_left_to_new_holder',
                holder: held.holder,
              }),
            );
            return;
          }
          await dropTransientStaging(this.env.DB);
        });
      } catch (dropErr) {
        dropFailed = true;
        dropFailure = dropErr;
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'etl_refresh_staging_drop_failed',
            error: dropErr instanceof Error ? dropErr.message : String(dropErr),
            afterFailure: failed,
          }),
        );
      }
      // The lease is released whatever happened above. Its own failure is logged, never allowed to
      // REPLACE the run's error (or the drop's): the TTL bounds a lease that could not be released.
      let releaseFailed = false;
      let releaseFailure: unknown = null;
      try {
        await step.do('release-refresh-lease', async () =>
          releaseRefreshLease(this.env.DB, leaseHolder),
        );
      } catch (releaseErr) {
        releaseFailed = true;
        releaseFailure = releaseErr;
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'etl_refresh_lease_release_failed',
            error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
            afterFailure: failed || dropFailed,
          }),
        );
      }
      // The run's own error (already propagating) always wins; on an otherwise successful run the
      // FIRST failure inside finally is the run's result.
      if (!failed) {
        // Explicit flags, not null sentinels: a thrown `null` or `undefined` is still a failure.
        if (dropFailed) throw dropFailure;
        if (releaseFailed) throw releaseFailure;
      }
      if (outcome) {
        console.log(JSON.stringify({ level: 'info', event: 'etl_refresh_complete', ...outcome }));
      }
    }
  }
}

export default {
  // Cron entrypoint: kick one durable refresh run. No public route or HTTP trigger is configured.
  async scheduled(_controller, env): Promise<void> {
    const instance = await env.REFRESH.create();
    console.log(JSON.stringify({ level: 'info', event: 'etl_scheduled_refresh', id: instance.id }));
  },
} satisfies ExportedHandler<Env>;
