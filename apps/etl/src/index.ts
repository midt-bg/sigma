export { DeclarationCorpus } from './declaration-corpus';
import type { DeclarationEnv, DeclarationContainer } from './declarations';
export { DeclarationContainer } from './declarations';
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
  registryClient,
  registryDay,
  RegistryError,
  releaseRefreshLease,
  renewRefreshLease,
  runRefreshSliceStatementGroup,
  settlePendingWindows,
} from '@sigma/ingest';
import refreshSliceSql from '../../../scripts/refresh-slice.sql';
import workStagingSchemaSql from '../../../scripts/work-staging-schema.sql';
import { computeWorkerCatchupPlan, ingestBucketWindow, type CatchupPlan } from './eop';
import { runServedIntegrityGate } from './integrity';
import {
  acquireRegistryLease,
  completeEntryBaseline,
  nextQueued,
  prepareEntryBaseline,
  queueNewWinners,
  releaseRegistryLease,
  renewRegistryLease,
  seedEntryPasses,
  nextEntryPass,
  recordEntryPage,
  deferPortal,
  deferDeed,
  deferXml,
  storeDeed,
} from './registry';

export interface Env extends DeclarationEnv {
  DECLARATIONS?: DurableObjectNamespace<DeclarationContainer>;
  DECLARATIONS_ENABLED?: string;
  /** The operator's trigger for one declarations run; the weekly cron starts the same run. */
  DECLARATIONS_RUN?: Workflow;
  DB: D1Database;
  REFRESH: Workflow;
  EOP_OPEN_DATA_BASE_URL?: string;
  /** The register layer (ADR-0041): its Workflow, and the API it reads. Unset → the layer does not run. */
  REGISTRY?: Workflow;
  REGISTRY_API_BASE_URL?: string;
  REGISTRY_PORTAL_URL?: string;
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

// Every step that WRITES runs behind the fence: renew the lease, and if it is no longer ours,
// stop before touching anything. Workflows resume a run from cached step results after retries
// that can outlast the TTL, so "acquired" at step one proves nothing at step twenty — the data
// path may belong to a newer instance by then. Losing the lease is final for this run.
function fence(step: WorkflowStep, lostLease: (name: string) => Promise<string | null>) {
  return <T extends Rpc.Serializable<T>>(name: string, fn: () => Promise<T>): Promise<T> =>
    step.do(name, async () => {
      const lost = await lostLease(name);
      if (lost !== null) throw new NonRetryableError(lost);
      return fn();
    });
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
    const fenced = fence(step, async (name) => {
      const held = await renewRefreshLease(this.env.DB, leaseHolder, new Date());
      return held.acquired
        ? null
        : `refresh lease lost before ${name}: now held by ${held.holder ?? 'nobody'}`;
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
    // The FIRST failure inside finally, boxed rather than a null sentinel: a thrown `null` or
    // `undefined` is still a failure. Later cleanup failures are logged, never allowed to REPLACE
    // the run's error (or an earlier cleanup's).
    let cleanupFailure = null as { error: unknown } | null;
    const swallow = async (event: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            event,
            error: err instanceof Error ? err.message : String(err),
            afterFailure: failed || cleanupFailure !== null,
          }),
        );
        cleanupFailure ??= { error: err };
      }
    };

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
      throw err;
    } finally {
      // The staging tables are ours to drop only while the lease is ours: if a newer instance took
      // it over, they are ITS tables now. A lost lease here is logged, not thrown — the run has
      // already failed or finished, and the release below must still happen.
      await swallow('etl_refresh_staging_drop_failed', () =>
        step.do('drop-transient-staging', async () => {
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
        }),
      );
      // The lease is released whatever happened above: the TTL bounds a lease that could not be
      // released.
      await swallow('etl_refresh_lease_release_failed', () =>
        step.do('release-refresh-lease', async () => releaseRefreshLease(this.env.DB, leaseHolder)),
      );
      // The run's own error (already propagating) always wins; on an otherwise successful run the
      // FIRST failure inside finally is the run's result.
      if (!failed && cleanupFailure) throw cleanupFailure.error;
      if (outcome) {
        console.log(JSON.stringify({ level: 'info', event: 'etl_refresh_complete', ...outcome }));
      }
    }
  }
}

interface RegistryParams {
  /** Operator override for tests/manual runs. Normal cron uses UTC today. */
  today?: string;
  /** Partidas read per run; the default fills a winners' scope of ~13k in under two days. */
  maxDeeds?: number;
  maxPages?: number;
  portalPaceMs?: number;
  /** Pause between two reads, under the API's per-client limit; 0 in tests. */
  paceMs?: number;
}

interface RegistryResult {
  skipped?: 'not-configured' | 'lease-held';
  changeDays: number;
  changed: number;
  queuedNew: number;
  read: number;
  absent: number;
  roles: number;
}

// Partidas per step: small, so a retried step re-reads little (storing is idempotent, the queue is the cursor).
const REGISTRY_BATCH = 25;
// Four runs a day at this bound fill the winners' scope in about two days, then only follow the changes.
const REGISTRY_MAX_DEEDS = 2_500;
// A bounded amount of persistent portal pagination per run; unfinished passes resume next time.
const REGISTRY_MAX_PAGES = 600;
// The published XML API has no configured quota; actual Retry-After responses still apply.
const REGISTRY_PACE_MS = 0;

// Published XML partidas and portal entry-day passes have their own lease beside procurement.
// Pending entry signals survive until confirmed by exact timestamps in the XML history.
export class RegistryWorkflow extends WorkflowEntrypoint<Env, RegistryParams> {
  override async run(
    event: WorkflowEvent<RegistryParams>,
    step: WorkflowStep,
  ): Promise<RegistryResult> {
    const result: RegistryResult = {
      changeDays: 0,
      changed: 0,
      queuedNew: 0,
      read: 0,
      absent: 0,
      roles: 0,
    };
    const baseUrl = this.env.REGISTRY_API_BASE_URL;
    if (!baseUrl) {
      console.warn(JSON.stringify({ level: 'warn', event: 'registry_not_configured' }));
      return { ...result, skipped: 'not-configured' };
    }
    const params = event.payload ?? {};
    const holder = event.instanceId;
    const startedAt = new Date().toISOString();
    const acquired = await step.do('acquire-registry-lease', async () =>
      acquireRegistryLease(this.env.DB, holder, new Date(startedAt)),
    );
    if (!acquired) {
      console.warn(JSON.stringify({ level: 'warn', event: 'registry_lease_held', startedAt }));
      return { ...result, skipped: 'lease-held' };
    }
    // Renewed before every step that writes; losing it is final, as in the refresh.
    const fenced = fence(step, async (name) =>
      (await renewRegistryLease(this.env.DB, holder)) ? null : `registry lease lost before ${name}`,
    );
    const client = registryClient({ baseUrl, portalUrl: this.env.REGISTRY_PORTAL_URL });
    const pace = params.paceMs ?? REGISTRY_PACE_MS;
    const maxDeeds = params.maxDeeds ?? REGISTRY_MAX_DEEDS;
    try {
      const today = params.today ?? registryDay(new Date(startedAt));
      const baseline = await fenced('prepare-entry-baseline', () =>
        prepareEntryBaseline(this.env.DB, today, holder, startedAt),
      );
      if (baseline === 'missing-marker')
        throw new NonRetryableError(
          'registry data exists without a verified full-import marker; rebuild or restore its receipt',
        );
      if (baseline === 'ready')
        await fenced('seed-entry-passes', () => seedEntryPasses(this.env.DB, today, startedAt));
      for (
        let page = 0;
        baseline === 'ready' && page < (params.maxPages ?? REGISTRY_MAX_PAGES);
        page++
      ) {
        const pass = await step.do(`entry-pass:${page}`, () =>
          nextEntryPass(this.env.DB, today, new Date().toISOString()),
        );
        if (!pass) break;
        // Both ways the portal closes a pass early: its Retry-After answer, or any other failed read.
        const deferPass = async (name: string, retryMs: number, error: string | null) => {
          await fenced(name, () =>
            deferPortal(this.env.DB, new Date(Date.now() + retryMs).toISOString()),
          );
          console.warn(
            JSON.stringify({
              event: 'registry_portal_deferred',
              day: pass.day,
              page: pass.next_page,
              error,
            }),
          );
        };
        try {
          if (page > 0 && (params.portalPaceMs ?? 30_000) > 0)
            await step.sleep(`portal-pace:${page}`, params.portalPaceMs ?? 30_000);
          // Catch inside the durable step: Workflow retries must not bypass Retry-After,
          // and custom Error properties do not survive durable serialization.
          const read = await step.do(`portal-read:${page}`, async () => {
            try {
              return {
                response: await client.changes(pass.day, pass.next_page),
                error: null,
                retryMs: 0,
              };
            } catch (error) {
              return {
                response: null,
                error: String(error),
                retryMs:
                  error instanceof RegistryError ? (error.retryMs ?? 6 * 3600000) : 6 * 3600000,
              };
            }
          });
          if (!read.response) {
            await deferPass(`portal-retry-after:${page}`, read.retryMs, read.error);
            break;
          }
          const response = read.response;
          result.changed += await fenced(`portal-save:${page}`, () =>
            recordEntryPage(this.env.DB, pass, response, new Date().toISOString()),
          );
          if (!response.hasMore) result.changeDays++;
        } catch (error) {
          if (error instanceof NonRetryableError) throw error;
          const wait =
            error instanceof RegistryError ? (error.retryMs ?? 6 * 3600000) : 6 * 3600000;
          await deferPass(`portal-defer:${page}`, wait, String(error));
          break;
        }
      }
      result.queuedNew = await fenced('queue-new-winners', async () =>
        queueNewWinners(this.env.DB, new Date().toISOString(), maxDeeds),
      );
      for (let b = 0; result.read < maxDeeds; b++) {
        const batch = await fenced(`deeds:${b}`, async () => {
          const eiks = await nextQueued(
            this.env.DB,
            Math.min(REGISTRY_BATCH, maxDeeds - result.read),
          );
          let absent = 0;
          let roles = 0;
          for (const [i, eik] of eiks.entries()) {
            if (i > 0 && pace > 0) await new Promise((r) => setTimeout(r, pace));
            try {
              const lookup = await client.deed(eik);
              if (!(await renewRegistryLease(this.env.DB, holder)))
                throw new NonRetryableError('registry lease lost after XML read');
              if (lookup.status === 'absent') absent++;
              roles += (await storeDeed(this.env.DB, eik, lookup, new Date().toISOString())).roles;
            } catch (error) {
              if (error instanceof NonRetryableError) throw error;
              if (!(await renewRegistryLease(this.env.DB, holder)))
                throw new NonRetryableError('registry lease lost after failed read');
              const wait =
                error instanceof RegistryError
                  ? Math.max(error.retryMs ?? 0, 6 * 3600000)
                  : 6 * 3600000;
              await deferDeed(this.env.DB, eik, new Date(Date.now() + wait).toISOString());
              if (
                error instanceof RegistryError &&
                (error.status === 429 || error.status === 503)
              ) {
                await deferXml(
                  this.env.DB,
                  new Date(Date.now() + (error.retryMs ?? 180_000)).toISOString(),
                );
                break;
              }
              console.warn(
                JSON.stringify({ event: 'registry_deed_deferred', eik, error: String(error) }),
              );
            }
          }
          return { read: eiks.length, absent, roles };
        });
        result.read += batch.read;
        result.absent += batch.absent;
        result.roles += batch.roles;
        if (batch.read < REGISTRY_BATCH) break;
      }
      if (baseline === 'building') {
        const complete = await fenced('complete-entry-baseline', () =>
          completeEntryBaseline(this.env.DB, holder, new Date().toISOString()),
        );
        console.log(
          JSON.stringify({
            level: 'info',
            event: complete ? 'registry_baseline_complete' : 'registry_baseline_building',
            runId: holder,
          }),
        );
      }
      console.log(JSON.stringify({ level: 'info', event: 'registry_refresh_complete', ...result }));
      return result;
    } finally {
      await step.do('release-registry-lease', async () =>
        releaseRegistryLease(this.env.DB, holder),
      );
    }
  }
}

/** The cron that starts the declarations run: Mondays 03:00 UTC, as the register is quiet then. */
export const DECLARATIONS_CRON = '0 3 * * 1';

/** An operator-started declarations run that waits for the container's outcome, so `wrangler workflows
 * trigger` reports the real result instead of a fire-and-forget. The cron starts the same run. */
export class DeclarationsWorkflow extends WorkflowEntrypoint<Env> {
  override async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const declarations = this.env.DECLARATIONS;
    if (!declarations) throw new NonRetryableError('The declarations container is not bound');
    const start = await step.do('start-declarations', async () => {
      const { runId, state } = await declarations
        .getByName('declarations')
        .startRun(event.instanceId);
      return { runId, state };
    });
    for (let poll = 0; ; poll++) {
      await step.sleep(`wait-${poll}`, '5 minutes');
      const run = await step.do(`status-${poll}`, async () => {
        const current = await declarations.getByName('declarations').getRun();
        return current
          ? {
              runId: current.runId,
              state: current.state,
              audit: current.audit ?? false,
              published: current.published ?? false,
              reason: current.reason ?? null,
              startedAt: current.startedAt ?? null,
              finishedAt: current.finishedAt ?? null,
              attempt: current.attempt,
              stage: current.stage,
              completed: current.completed,
              lastProgressAt: current.lastProgressAt,
              retryAt: current.retryAt ?? null,
            }
          : null;
      });
      if (!run || run.runId !== start.runId) throw new NonRetryableError('Declaration run changed');
      if (run.state === 'complete') return run;
      if (run.state !== 'running')
        throw new NonRetryableError(`Declaration run ${run.state}: ${run.reason ?? ''}`);
    }
  }
}

export default {
  // Cron entrypoint: kick one durable refresh run, and the register layer beside it where it is configured.
  // No public route or HTTP trigger is configured.
  async scheduled(controller, env): Promise<void> {
    // The weekly cron owns the declarations; every other tick refreshes procurement and the register.
    const weekly = controller?.cron === DECLARATIONS_CRON;
    const jobs: [string, () => Promise<unknown>][] = [];
    if (!weekly) {
      jobs.push(['refresh', () => env.REFRESH.create()]);
      if (env.REGISTRY && env.REGISTRY_API_BASE_URL)
        jobs.push(['registry', () => env.REGISTRY!.create()]);
    } else if (env.DECLARATIONS_ENABLED === 'true' && env.DECLARATIONS)
      jobs.push(['declarations', () => env.DECLARATIONS!.getByName('declarations').startRun()]);
    const results = await Promise.allSettled(
      jobs.map(async ([job, start]) => {
        const result = await start();
        console.log(JSON.stringify({ event: 'etl_scheduled', job, result }));
      }),
    );
    const failures = results.flatMap((r, i) =>
      r.status === 'rejected' ? [new Error(`${jobs[i]![0]}: ${String(r.reason)}`)] : [],
    );
    if (failures.length) throw new AggregateError(failures, 'ETL scheduled starts failed');
  },
} satisfies ExportedHandler<Env>;
