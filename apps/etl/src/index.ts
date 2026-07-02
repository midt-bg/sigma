import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  createTransientStaging,
  dropTransientStaging,
  refreshDerivedContractCount,
  refreshSliceStatementGroups,
  runRefreshSliceStatementGroup,
} from '@sigma/ingest';
import refreshSliceSql from '../../../scripts/refresh-slice.sql';
import workStagingSchemaSql from '../../../scripts/work-staging-schema.sql';
import { PROMPTS_CRON, REFRESH_CRON } from './crons';
import { computeWorkerCatchupPlan, ingestBucketWindow, type CatchupPlan } from './eop';
import { generateSuggestedPrompts } from './suggested-prompts';

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
        return { ...plan, days: results.length, staged: 0, derived: 0 };
      }

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

      return { ...plan, days: results.length, staged, derived };
    } finally {
      await step.do('drop-transient-staging', async () => dropTransientStaging(this.env.DB));
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
