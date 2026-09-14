import { DurableObject } from 'cloudflare:workers';

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
/** One native Container + its Durable Object. No HTTP endpoint or additional Workflow. */
export class DeclarationContainer extends DurableObject<DeclarationEnv> {
  async startRun(): Promise<{ runId: string; state: string }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.ctx.storage.get<{
        runId: string;
        state: string;
        startedAt?: number;
      }>('run');
      const container = this.ctx.container;
      if (!container) throw new Error('Declaration container is not configured');
      if (container.running) return current ?? { runId: 'unknown', state: 'running' };
      const env: Record<string, string> = {};
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
      if (!this.env.DECLARATIONS_CORPUS) throw new Error('Missing corpus binding');
      const checkpoint = await this.env.DECLARATIONS_CORPUS.get('declarations/working.json');
      env.DECLARATIONS_RESTORE = checkpoint ? await checkpoint.text() : 'null';
      const run = { runId: crypto.randomUUID(), state: 'running', startedAt: Date.now() };
      env.SIGMA_RUN_ID = run.runId;
      await this.ctx.storage.put('run', run);
      container.start({ enableInternet: true, env });
      await container.setInactivityTimeout(10 * 60 * 1000);
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return run;
    });
  }
  override async alarm(): Promise<void> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const container = this.ctx.container!;
      const run = await this.ctx.storage.get<{ runId: string; state: string; startedAt?: number }>(
        'run',
      );
      if (!run || run.state !== 'running') return;
      if (run.startedAt && Date.now() - run.startedAt > 6 * 3600000) {
        await container.destroy();
        await this.ctx.storage.put('run', { ...run, state: 'failed', reason: 'deadline' });
        return;
      }
      if (!container.running) {
        await this.ctx.storage.put('run', { ...run, state: 'interrupted' });
        return; // the next cron restores the last acknowledged R2 checkpoint
      }
      try {
        const res = await container
          .getTcpPort(8080)
          .fetch('http://container/status', { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error('Container status unavailable');
        const status = await res.json<{ runId: string; state: string }>();
        if (status.runId !== run.runId) throw new Error('Container run mismatch');
        if (status.state === 'complete' || status.state === 'failed') {
          await this.ctx.storage.put('run', {
            ...run,
            state: status.state,
            finishedAt: new Date().toISOString(),
          });
          await container.destroy();
          return;
        }
      } catch {
        /* startup/status failures are retried while the process is alive */
      }
      await container.setInactivityTimeout(10 * 60 * 1000);
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    });
  }
}
