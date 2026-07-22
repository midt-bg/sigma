import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
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
import { computeWorkerCatchupPlan, ingestBucketWindow, type CatchupPlan } from './eop';

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

      return { ...plan, days: results.length, staged, derived };
    } finally {
      await step.do('drop-transient-staging', async () => dropTransientStaging(this.env.DB));
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
