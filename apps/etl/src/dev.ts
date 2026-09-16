export { DeclarationCorpus } from './declaration-corpus';
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { DeclarationContainer, type DeclarationEnv } from './declarations';

// Manual dev verification uses the real jobs, without the production scheduler or a public endpoint.
export { RegistryWorkflow } from './index';
export { DeclarationContainer };

interface DevEnv extends DeclarationEnv {
  DECLARATIONS: DurableObjectNamespace<DeclarationContainer>;
}

export class DevDeclarationsWorkflow extends WorkflowEntrypoint<DevEnv> {
  override async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    if (
      this.env.SIGMA_D1_ID !== '713b98fa-6ab5-45f3-81c4-119f4c0907d6' ||
      this.env.SIGMA_D1_NAME !== 'sigma-dev' ||
      this.env.SIGMA_SHIP_ENV !== 'dev' ||
      this.env.DECLARATIONS_BUCKET !== 'sigma-declarations-dev'
    )
      throw new Error('Declaration verification requires the isolated dev resources');

    const start = await step.do('start-declarations', async () => {
      const { runId, state } = await this.env.DECLARATIONS.getByName('declarations').startRun(
        event.instanceId,
      );
      return { runId, state };
    });
    for (let poll = 0; ; poll++) {
      await step.sleep(`wait-${poll}`, '5 minutes');
      const run = await step.do(`status-${poll}`, async () => {
        const current = await this.env.DECLARATIONS.getByName('declarations').getRun();
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
      if (!run || run.runId !== start.runId) throw new Error('Declaration run changed');
      if (run.state === 'complete') return run;
      if (run.state !== 'running')
        throw new Error(`Declaration run ${run.state}: ${run.reason ?? ''}`);
    }
  }
}
export default {};
