import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  createTransientStaging,
  dropTransientStaging,
  loadFxRates,
  refreshDerivedContractCount,
  refreshSliceStatementGroups,
  runRefreshSliceStatementGroup,
} from '@sigma/ingest';
import refreshSliceSql from '../../../scripts/refresh-slice.sql';
import workStagingSchemaSql from '../../../scripts/work-staging-schema.sql';
import { PROMPTS_CRON, REFRESH_CRON } from './crons';
import { computeWorkerCatchupPlan, ingestBucketWindow, type CatchupPlan } from './eop';
import { generateSuggestedPrompts } from './suggested-prompts';
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

    await step.do('drop-stale-transient-staging', async () => dropTransientStaging(this.env.DB));

    const plan = await step.do('plan-catchup', async () =>
      computeWorkerCatchupPlan(this.env.DB, {
        today: params.today,
        lookbackDays: params.lookbackDays,
        maxWindowDays: params.maxWindowDays,
      }),
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

    let results: Awaited<ReturnType<typeof ingestBucketWindow>> = [];
    let staged = 0;
    let derived = 0;
    // The runtime logs an error ("...your Worker's code had hung...") on every *successful* instance
    // of this Workflow, at the instant run() returns - measured across runs of 5 and 30 steps, see
    // docs/etl.md. "No errors in the dashboard" is therefore not a health signal here, so a refresh
    // that actually finished has to say so itself. Logged from the finally, after the staging drop,
    // so it only ever claims success for a run that survived its own cleanup.
    let outcome: RefreshResult | null = null;

    try {
      await step.do('create-transient-staging', async () =>
        createTransientStaging(this.env.DB, workStagingSchemaSql),
      );
      results = await step.do('ingest-storage-eop-bucket', async () =>
        ingestBucketWindow(this.env.DB, plan, {
          baseUrl: this.env.EOP_OPEN_DATA_BASE_URL,
          fetchedAt,
        }),
      );
      staged = stagedRows(results);

      if (staged === 0) {
        console.warn(JSON.stringify({ level: 'warn', event: 'etl_zero_ingest', fetchedAt, plan }));
        outcome = { ...plan, days: results.length, staged: 0, derived: 0 };
        return outcome;
      }

      // FX rates BEFORE the derive (#158): the CLI paths run scripts/load-fx.mjs first, but this
      // cron path never did — foreign-currency contracts staged here derived with a NULL
      // amount_eur and silently dropped out of every rollup. loadFxRates fetches only actual
      // coverage gaps (idempotent upsert into fx_rates) and throws — failing the run loudly —
      // when rates that plausibly exist could not be loaded.
      await step.do('load-fx', async () => {
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
        await step.do(`derive-slice:${group.name}`, async () => {
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
      derived = await step.do('derive-slice:count', async () =>
        refreshDerivedContractCount(this.env.DB),
      );

      // Keep the dock's starter chips in step with the freshly-derived slice. The weekly PROMPTS_CRON is a
      // coarse fallback; regenerating here means the chip numbers track each 6-hourly refresh instead of
      // lagging up to a week behind the data the assistant recomputes live. That skew is the S3 defect: a
      // chip computed on partial data showed „140 договора за 21,6 млн €" while the live query returned
      // 278 / 61,5 млн for the SAME window once late-arriving contracts backfilled. Best-effort — the slice
      // is already committed, so a prompts failure is logged, not fatal to the refresh.
      await step.do('refresh-suggested-prompts', async () => {
        try {
          await generateSuggestedPrompts(this.env.DB);
        } catch (error) {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'etl_prompts_failed',
              phase: 'refresh',
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      });

      // Reconciliation gate (#97) on the served D1 the refresh just wrote — the CLI paths gate every
      // derive, but this steady-state path did not. POST-COMMIT alarm: the slice is already applied
      // and served, so a violation fails the step + surfaces in observability, it does not un-serve
      // the drift (ship-and-alert; see issue #154 and docs/integrity-gate.md).
      await step.do('integrity-gate', async () => {
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

      outcome = { ...plan, days: results.length, staged, derived };
      return outcome;
    } finally {
      await step.do('drop-transient-staging', async () => dropTransientStaging(this.env.DB));
      if (outcome) {
        console.log(JSON.stringify({ level: 'info', event: 'etl_refresh_complete', ...outcome }));
      }
    }
  }
}

export default {
  // Cron entrypoint. Two triggers share this worker: the 6-hourly data refresh kicks a durable
  // Workflow run; the weekly cron rebuilds the assistant starter prompts. Branch on the cron string
  // (named constants above) — an unrecognised cron logs `etl_unknown_cron` rather than misrouting.
  async scheduled(controller, env, ctx): Promise<void> {
    if (controller.cron === PROMPTS_CRON) {
      // Surface a failure as a structured event rather than an anonymous unhandled rejection. The job
      // degrades safely (the prior rows stay served), so this is observability, not a fatal path.
      ctx.waitUntil(
        generateSuggestedPrompts(env.DB).catch((error) =>
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'etl_prompts_failed',
              message: error instanceof Error ? error.message : String(error),
            }),
          ),
        ),
      );
      return;
    }
    if (controller.cron === REFRESH_CRON) {
      const instance = await env.REFRESH.create();
      console.log(
        JSON.stringify({ level: 'info', event: 'etl_scheduled_refresh', id: instance.id }),
      );
      return;
    }
    console.log(
      JSON.stringify({ level: 'warn', event: 'etl_unknown_cron', cron: controller.cron }),
    );
  },
} satisfies ExportedHandler<Env>;
