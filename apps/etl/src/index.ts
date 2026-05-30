import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  discoverOcdsDatasets,
  fetchOcdsPackage,
  findJsonResource,
  releaseToContracts,
  runRefreshSlice,
  upsertContractStaging,
  type OcdsMeta,
  type OcdsRelease,
} from '@sigma/ingest';
import refreshSliceSql from '../../../scripts/refresh-slice.sql';

export interface Env {
  DB: D1Database;
  REFRESH: Workflow;
}

interface RefreshParams {
  /** Limit to a single OCDS dataset URI (else the newest period is discovered). */
  datasetUri?: string;
  /** Test/fixture override: stage these releases directly, skipping the live fetch. */
  releases?: OcdsRelease[];
  /** Source tag for fixture releases (default 'ocds:fixture'). */
  source?: string;
}

// The on-platform daily refresh. Durable, individually-retried steps: discover the newest OCDS
// period → fetch it → upsert the contract staging → scoped re-derive of the touched slice +
// refresh its rollup/FTS rows (scripts/refresh-slice.sql). The full-rebuild normalize stays off
// this path; the Queue fan-out for the TR backfill is deferred. Raw archival is delegated to the
// external BG feeder (see docs/etl-pipeline.md).
export class RefreshWorkflow extends WorkflowEntrypoint<Env, RefreshParams> {
  override async run(
    event: WorkflowEvent<RefreshParams>,
    step: WorkflowStep,
  ): Promise<{ datasets: number; staged: number; derived: number }> {
    const params = event.payload ?? {};
    const fetchedAt = new Date().toISOString();

    // 1) Which OCDS dataset(s) to refresh. A fixture (params.releases) is a single synthetic dataset.
    const datasets = await step.do('discover', async () => {
      if (params.releases) {
        return [
          {
            uri: 'fixture',
            resourceUri: 'fixture',
            source: params.source ?? 'ocds:fixture',
            year: null as number | null,
          },
        ];
      }
      const all = await discoverOcdsDatasets();
      const picked = params.datasetUri
        ? all.filter((d) => d.uri === params.datasetUri)
        : all.slice(0, 1);
      const out = [];
      for (const ds of picked) {
        const res = await findJsonResource(ds.uri);
        if (res)
          out.push({
            uri: ds.uri,
            resourceUri: res.uri,
            source: `ocds:${ds.year}:${ds.periodStart}`,
            year: ds.year,
          });
      }
      return out;
    });

    // 2) Per dataset: fetch + flatten + upsert staging (big payload stays inside the step; only the
    //    small {staged} count is persisted as the step result). No raw archival — the BG feeder
    //    owns that.
    let staged = 0;
    for (const ds of datasets) {
      const meta: OcdsMeta = {
        source: ds.source,
        datasetUri: ds.uri,
        resourceUri: ds.resourceUri,
        year: ds.year,
        fetchedAt,
      };
      const n = await step.do(`ingest:${ds.source}`, async () => {
        const releases: OcdsRelease[] =
          params.releases ?? (await fetchOcdsPackage(ds.resourceUri)).releases ?? [];
        const rows = releases.flatMap((rel) => releaseToContracts(rel, meta));
        return upsertContractStaging(this.env.DB, ds.source, rows);
      });
      staged += n;
    }

    // 3) Scoped re-derive + refresh the affected rollup/FTS rows.
    const derived = await step.do('derive-slice', async () =>
      runRefreshSlice(this.env.DB, refreshSliceSql),
    );

    return { datasets: datasets.length, staged, derived };
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', service: 'sigma-etl' });
    }
    if (url.pathname === '/etl/refresh' && request.method === 'POST') {
      const params = request.headers.get('content-type')?.includes('application/json')
        ? ((await request.json()) as RefreshParams)
        : {};
      const instance = await env.REFRESH.create({ params });
      return Response.json({ id: instance.id, status: await instance.status() });
    }
    if (url.pathname.startsWith('/etl/refresh/') && request.method === 'GET') {
      const id = url.pathname.slice('/etl/refresh/'.length);
      const instance = await env.REFRESH.get(id);
      return Response.json({ id, status: await instance.status() });
    }
    return new Response('Not found', { status: 404 });
  },

  // Cron entrypoint: kick one durable refresh run (discovers the newest OCDS period itself).
  async scheduled(_controller, env): Promise<void> {
    await env.REFRESH.create();
  },
} satisfies ExportedHandler<Env>;
