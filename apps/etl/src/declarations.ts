import { DurableObject, exports as workerExports } from 'cloudflare:workers';

export interface DeclarationEnv {
  DECLARATIONS_CORPUS?: R2Bucket;
  DECLARATIONS_BUCKET?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  SIGMA_D1_ID?: string;
  SIGMA_D1_NAME?: string;
  SIGMA_SHIP_ENV?: string;
  SUPPRESSION_SALT?: string;
  SUPPRESSION_KEY_VERSION?: string;
}
interface DeclarationRun {
  runId: string;
  requestId?: string;
  state: 'running' | 'complete' | 'failed';
  audit?: true;
  published?: true;
  startedAt: number;
  finishedAt?: string;
  reason?: string;
  attempt: number;
  attemptStartedAt: number;
  retryAt?: number;
  failures: number;
  stage: string;
  completed: number;
  total?: number;
  progressVersion: number;
  attemptProgressVersion: number;
  lastProgressAt: number;
}
interface ContainerStatus {
  runId: string;
  attempt: number;
  state: 'running' | 'complete' | 'failed' | 'yielded';
  stage: string;
  completed: number;
  total?: number;
  reason?: string;
  signal?: string;
  audit?: boolean;
  published?: boolean;
}
const stages = [
  'fetch',
  'snapshot',
  'extract',
  'candidates',
  'decide',
  'load',
  'audit',
  'publish',
  'reindex',
];
const MINUTE = 60_000;
// Restart a stalled attempt; three attempts without advancing the durable high-water mark stop.
const STALL_MS = 20 * MINUTE;
const MAX_FAILURES = 3;

/** One coordinator and one container; R2 checkpoints survive every container attempt. */
export class DeclarationContainer extends DurableObject<DeclarationEnv> {
  getRun() {
    return this.ctx.storage.get<DeclarationRun>('run');
  }
  private settings() {
    if (!this.ctx.container || !this.env.DECLARATIONS_CORPUS)
      throw new Error('Declaration container and corpus binding are required');
    const env: Record<string, string> = { CACBG_CORPUS_URL: 'http://declarations.r2' };
    for (const key of [
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
      'SIGMA_D1_ID',
      'SIGMA_D1_NAME',
      'SIGMA_SHIP_ENV',
      'DECLARATIONS_BUCKET',
    ] as const) {
      const value = this.env[key];
      if (!value) throw new Error(`Missing declaration setting: ${key}`);
      env[key] = value;
    }
    for (const key of ['SUPPRESSION_SALT', 'SUPPRESSION_KEY_VERSION'] as const)
      if (this.env[key]) env[key] = this.env[key];
    return env;
  }
  async startRun(requestId?: string): Promise<DeclarationRun> {
    this.settings();
    if (requestId !== undefined && (!requestId || requestId.length > 256))
      throw new Error('Invalid request ID');
    // Only storage is inside the transaction. The alarm owns all container I/O.
    return this.ctx.storage.transaction(async (storage) => {
      const current = await storage.get<DeclarationRun>('run');
      if (
        current &&
        (current.state === 'running' || (requestId && current.requestId === requestId))
      )
        return current;
      if (this.ctx.container!.running) throw new Error('Unaccounted active declaration container');
      const now = Date.now();
      const run: DeclarationRun = {
        runId: crypto.randomUUID(),
        ...(requestId ? { requestId } : {}),
        state: 'running',
        startedAt: now,
        attempt: 0,
        attemptStartedAt: now,
        failures: 0,
        stage: 'fetch',
        completed: 0,
        progressVersion: 0,
        attemptProgressVersion: 0,
        lastProgressAt: now,
      };
      await storage.put('run', run);
      await storage.setAlarm(now + 1);
      return run;
    });
  }
  private async finish(run: DeclarationRun, state: 'complete' | 'failed', reason?: string) {
    await this.ctx.container!.destroy();
    await this.ctx.storage.put('run', {
      ...run,
      state,
      ...(state === 'complete' ? { audit: true, published: true } : {}),
      reason,
      finishedAt: new Date().toISOString(),
    });
  }
  private async retry(run: DeclarationRun, reason: string, yielded = false) {
    const failures = run.progressVersion > run.attemptProgressVersion ? 0 : run.failures + 1;
    if (failures >= MAX_FAILURES) {
      await this.finish(run, 'failed', `${reason}; ${failures} attempts without progress`);
      return;
    }
    await this.ctx.container!.destroy();
    const retryAt = Date.now() + (yielded && !failures ? 1000 : MINUTE * 2 ** failures);
    await this.ctx.storage.put('run', { ...run, failures, reason, retryAt });
    await this.ctx.storage.setAlarm(retryAt);
  }
  override async alarm(): Promise<void> {
    const run = await this.getRun();
    if (!run || run.state !== 'running') return;
    const container = this.ctx.container!;
    if (run.retryAt && Date.now() < run.retryAt) {
      await this.ctx.storage.setAlarm(run.retryAt);
      return;
    }
    // Set the next alarm before external I/O, so a platform failure cannot strand the run.
    await this.ctx.storage.setAlarm(Date.now() + MINUTE);
    if (!run.attempt || run.retryAt) {
      run.attempt++;
      run.attemptStartedAt = Date.now();
      run.attemptProgressVersion = run.progressVersion;
      delete run.retryAt;
      delete run.reason;
      await this.ctx.storage.put('run', run);
      try {
        await container.interceptOutboundHttp(
          'declarations.r2',
          workerExports.DeclarationCorpus({ props: {} }),
        );
        container.start({
          enableInternet: true,
          env: { ...this.settings(), SIGMA_RUN_ID: run.runId, SIGMA_ATTEMPT: String(run.attempt) },
        });
        await container.setInactivityTimeout(10 * MINUTE);
      } catch (error) {
        await this.retry(run, error instanceof Error ? error.message : 'Container start failed');
      }
      return;
    }
    if (!container.running) {
      await this.retry(run, 'Container interrupted');
      return;
    }
    let status: ContainerStatus | undefined;
    let readError = 'Container made no progress';
    try {
      const res = await container
        .getTcpPort(8080)
        .fetch('http://container/status', { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`Container status returned ${res.status}`);
      status = await res.json<ContainerStatus>();
    } catch (error) {
      readError = error instanceof Error ? error.message : 'Container status unavailable';
    }
    if (status) {
      if (status.runId !== run.runId || status.attempt !== run.attempt) {
        await this.finish(run, 'failed', 'Container run or attempt mismatch');
        return;
      }
      const next = stages.indexOf(status.stage),
        previous = stages.indexOf(run.stage);
      if (
        next < 0 ||
        !Number.isSafeInteger(status.completed) ||
        status.completed < 0 ||
        !['running', 'complete', 'yielded', 'failed'].includes(status.state)
      ) {
        await this.finish(run, 'failed', 'Invalid container progress');
        return;
      }
      if (next > previous || (next === previous && status.completed > run.completed)) {
        run.stage = status.stage;
        run.completed = status.completed;
        if (Number.isSafeInteger(status.total) && status.total! >= status.completed)
          run.total = status.total;
        else delete run.total;
        run.progressVersion++;
        run.lastProgressAt = Date.now();
        await this.ctx.storage.put('run', run);
      }
      if (status.state === 'complete') {
        await this.finish(
          run,
          status.audit && status.published ? 'complete' : 'failed',
          status.audit && status.published ? undefined : 'Missing audit/publication receipt',
        );
        return;
      }
      if (status.state === 'yielded' || status.state === 'failed') {
        const reason = status.reason || `${status.stage} ${status.state}`;
        if (status.stage === 'fetch' || status.signal)
          await this.retry(run, reason, status.state === 'yielded');
        else await this.finish(run, 'failed', reason); // A data/audit refusal is not a transient failure.
        return;
      }
    }
    if (Date.now() - Math.max(run.lastProgressAt, run.attemptStartedAt) > STALL_MS) {
      await this.retry(run, readError);
      return;
    }
    await container.setInactivityTimeout(10 * MINUTE);
  }
}
export { DeclarationCorpus } from './declaration-corpus';
