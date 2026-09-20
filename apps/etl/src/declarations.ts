import { DurableObject, exports as workerExports } from 'cloudflare:workers';

export interface DeclarationEnv {
  DECLARATIONS_CORPUS?: R2Bucket;
  DECLARATIONS_BUCKET?: string;
  // The workflow that asked for the run owns it: when the instance is gone, so is the run.
  DECLARATIONS_RUN?: Workflow;
  REBUILD_RUN?: Workflow;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  SIGMA_D1_ID?: string;
  SIGMA_D1_NAME?: string;
  SIGMA_SHIP_ENV?: string;
  SUPPRESSION_SALT?: string;
  SUPPRESSION_KEY_VERSION?: string;
}
/** The idle blue/green slot a rebuild writes (ADR-0048); absent for the weekly declarations run.
 * `resume` continues whatever the slot already holds from an earlier rebuild instead of emptying it. */
export interface RebuildTarget {
  name: string;
  id: string;
  resume?: boolean;
}
/** What `monitor()` saw, under its own storage key: the alarm owns `run` and must not race a promise. */
interface ContainerExit {
  runId: string;
  attempt: number;
  at: number;
  why: string;
}

interface DeclarationRun {
  runId: string;
  requestId?: string;
  target?: RebuildTarget;
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
  /** Consecutive times the platform had no container to give; separate from `failures` on purpose. */
  capacityWaits?: number;
  /** The container answered `/status` at least once during THIS attempt, i.e. an instance really ran. */
  attemptAlive?: true;
  attemptStage?: string;
  attemptCompleted?: number;
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
// A slot rebuild builds everything locally first, runs the declarations job in its local mode, then ships.
const rebuildStages = [
  'import',
  'registry',
  'precompute',
  'declarations',
  ...stages.slice(0, stages.indexOf('publish')),
  'search',
  'ship',
  'verify',
];
const MINUTE = 60_000;
// Restart a stalled attempt; three attempts without advancing the durable high-water mark stop.
const STALL_MS = 20 * MINUTE;
const MAX_FAILURES = 3;
/** Cloudflare has no container to give right now. That is the platform declining, not this run going
 *  wrong, and it must not spend the failure budget: three of them in a row ended the run after about
 *  fourteen minutes, and the weekly one then waits until the next Sunday for data nobody fetched. It
 *  gets its own, far more patient budget instead — the run still ends rather than waiting forever. */
const NO_CAPACITY = /no container instance that can be provided/i;
const MAX_CAPACITY_WAITS = 12;
/** Until a container has run ONCE in this run, a silent attempt could equally be a broken image, so the
 *  patience is shorter — but not as short as it first was. Three waits ended after about a quarter of an
 *  hour, and a busy evening killed run after run before any of them got a machine at all, while the cost
 *  of that patience is only a sleeping alarm: nothing runs, nothing is billed. Giving up too early costs
 *  a week of data for the Sunday run; waiting costs a few hours. Six waits ride out an evening and still
 *  surface a bad build inside the same working day. */
const MAX_COLD_CAPACITY_WAITS = 6;
const CAPACITY_BACKOFF_MS = 5 * MINUTE;
const MAX_CAPACITY_BACKOFF_MS = 40 * MINUTE;

/** One coordinator and one container; R2 checkpoints survive every container attempt. */
export class DeclarationContainer extends DurableObject<DeclarationEnv> {
  getRun() {
    return this.ctx.storage.get<DeclarationRun>('run');
  }
  private settings(target?: RebuildTarget) {
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
    if (target) {
      // The live slot is only read; the idle one is the only target. Never the same database.
      if (
        !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(target.id) ||
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(target.name) ||
        target.id === env.SIGMA_D1_ID ||
        target.name === env.SIGMA_D1_NAME
      )
        throw new Error('A rebuild targets the idle slot, never the live one');
      Object.assign(env, {
        SIGMA_LIVE_D1_ID: env.SIGMA_D1_ID,
        SIGMA_LIVE_D1_NAME: env.SIGMA_D1_NAME,
        SIGMA_D1_ID: target.id,
        SIGMA_D1_NAME: target.name,
        SIGMA_REBUILD: '1',
        ...(target.resume ? { SIGMA_REBUILD_RESUME: '1' } : {}),
      });
    }
    return env;
  }
  async startRun(requestId?: string, target?: RebuildTarget): Promise<DeclarationRun> {
    this.settings(target);
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
        ...(target ? { target } : {}),
        state: 'running',
        startedAt: now,
        attempt: 0,
        attemptStartedAt: now,
        failures: 0,
        stage: target ? 'import' : 'fetch',
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
  /** The workflow instance that asked for this run is its owner. Terminate the instance and the
   * container stops too — otherwise the alarm would keep restarting a run nobody waits for. A
   * lookup that fails says nothing, so a healthy run is never stopped on a transient error. */
  private async ownerGone(run: DeclarationRun): Promise<boolean> {
    const workflow = run.target ? this.env.REBUILD_RUN : this.env.DECLARATIONS_RUN;
    if (!run.requestId || !workflow) return false;
    try {
      const { status } = await (await workflow.get(run.requestId)).status();
      return ['terminated', 'errored', 'complete'].includes(status);
    } catch {
      return false;
    }
  }
  private async retry(run: DeclarationRun, reason: string, yielded = false, stalled = false) {
    if (NO_CAPACITY.test(reason)) return this.waitForCapacity(run, reason);
    // A resumed attempt must first REPLAY its way back to the durable high-water mark, and that replay
    // grows with the corpus: at two hundred thousand documents it costs about ten minutes, while a
    // container the platform keeps taking away lives five to ten. Measuring only against the durable
    // mark therefore called every one of those attempts „without progress" and ended the run after
    // three — the further the run had got, the surer it was to die (seen twice on stage, at 199 804 and
    // at 208 053 documents).
    //
    // So the question is not whether the attempt passed the mark; it is whether the attempt was MOVING
    // when it was cut short. A stall is the other case and still counts: there the container is alive
    // and simply not advancing, which is this run failing, and `stalled` says so at the one call site
    // that knows it. `lastProgressAt` carries the attempt's own advance, replay included.
    const advanced =
      !stalled &&
      (run.progressVersion > run.attemptProgressVersion ||
        run.lastProgressAt > run.attemptStartedAt);
    const failures = advanced ? 0 : run.failures + 1;
    if (failures >= MAX_FAILURES) {
      await this.finish(run, 'failed', `${reason}; ${failures} attempts without progress`);
      return;
    }
    await this.ctx.container!.destroy();
    const retryAt = Date.now() + (yielded && !failures ? 1000 : MINUTE * 2 ** failures);
    await this.ctx.storage.put('run', { ...run, failures, reason, retryAt, capacityWaits: 0 });
    await this.ctx.storage.setAlarm(retryAt);
  }

  /** The platform declined to give a container. Wait it out on a separate budget, leaving the failure
   *  count — and the progress it is measured against — untouched. */
  private async waitForCapacity(run: DeclarationRun, reason: string, max = MAX_CAPACITY_WAITS) {
    const waits = (run.capacityWaits ?? 0) + 1;
    if (waits >= max) {
      await this.finish(run, 'failed', `${reason}; no container for ${waits} attempts`);
      return;
    }
    const retryAt =
      Date.now() + Math.min(CAPACITY_BACKOFF_MS * 2 ** (waits - 1), MAX_CAPACITY_BACKOFF_MS);
    await this.ctx.storage.put('run', { ...run, reason, retryAt, capacityWaits: waits });
    await this.ctx.storage.setAlarm(retryAt);
  }
  override async alarm(): Promise<void> {
    const run = await this.getRun();
    if (!run || run.state !== 'running') return;
    const container = this.ctx.container!;
    if (await this.ownerGone(run)) {
      await this.finish(run, 'failed', 'The workflow instance that started this run is gone');
      return;
    }
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
      delete run.attemptAlive;
      delete run.attemptStage;
      delete run.attemptCompleted;
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
          env: {
            ...this.settings(run.target),
            SIGMA_RUN_ID: run.runId,
            SIGMA_ATTEMPT: String(run.attempt),
          },
        });
        await container.setInactivityTimeout(10 * MINUTE);
        // A container that starts and dies seconds later looks exactly like one that never appeared:
        // both leave `running` false and silence. `monitor()` resolves when the instance exits, so the
        // exit is recorded under its own key — never by rewriting `run`, which the alarm owns — and the
        // next alarm can name what happened instead of waiting out a shortage that is not happening.
        // A broken image did exactly this on dev for hours: its CMD was `true`, so every instance left
        // within a minute and the whole thing read as „no machine".
        const { runId, attempt } = run;
        const noted = (why: string) =>
          this.ctx.storage.put('exit', { runId, attempt, at: Date.now(), why });
        void container
          .monitor()
          .then(
            () => noted('exited'),
            (error: unknown) => noted(error instanceof Error ? error.message : 'exited with error'),
          )
          .catch(() => {});
      } catch (error) {
        await this.retry(run, error instanceof Error ? error.message : 'Container start failed');
      }
      return;
    }
    if (!container.running) {
      // The shortage reaches us HERE, not as an exception from start(): the platform accepts the start
      // and then no instance appears. „Interrupted" is therefore two events wearing one name, and a
      // silent attempt cannot be told from a container that crashed before its first breath.
      //
      // What CAN be told apart is whether this attempt ever spoke. One that answered /status had a real
      // instance and really broke — ours to count. One that never made a sound gets the patient budget,
      // but only once this run has already had a working container: before that, a silent attempt is as
      // likely a broken build, and a bad build must fail in minutes rather than sit out four hours.
      //
      // And a third case the two above used to swallow: the instance DID arrive and left on its own.
      // `monitor()` recorded that, so it is named and counted as a failure of this run — a container
      // that exits before saying a word is a broken image far more often than a busy region, and it
      // must surface in minutes with what happened, not after hours of patience.
      const exit = await this.ctx.storage.get<ContainerExit>('exit');
      const ours = exit?.runId === run.runId && exit?.attempt === run.attempt;
      if (run.attemptAlive) await this.retry(run, 'Container interrupted');
      else if (ours && exit)
        await this.retry(
          run,
          `Container ${exit.why} ${Math.round((exit.at - run.attemptStartedAt) / 1000)}s after it started, without a word`,
        );
      else
        await this.waitForCapacity(
          run,
          'Container gave no sign of life',
          run.progressVersion > 0 ? MAX_CAPACITY_WAITS : MAX_COLD_CAPACITY_WAITS,
        );
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
      // An answer is the only proof an instance really ran, so this is where the waiting for one ends.
      run.attemptAlive = true;
      run.capacityWaits = 0;
      if (status.runId !== run.runId || status.attempt !== run.attempt) {
        await this.finish(run, 'failed', 'Container run or attempt mismatch');
        return;
      }
      const order = run.target ? rebuildStages : stages;
      const next = order.indexOf(status.stage),
        previous = order.indexOf(run.stage);
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
      }
      // Replaying a previous attempt is live progress, even below the durable high-water mark.
      const attemptStage = order.indexOf(run.attemptStage ?? '');
      if (
        next > attemptStage ||
        (next === attemptStage && status.completed > (run.attemptCompleted ?? -1))
      ) {
        run.attemptStage = status.stage;
        run.attemptCompleted = status.completed;
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
        // A yield is our own code stopping on purpose, with its work accepted — retry it wherever it
        // happens. Network stages are retried too; a data or audit refusal is final.
        if (
          status.state === 'yielded' ||
          ['fetch', 'import', 'registry'].includes(status.stage) ||
          status.signal
        )
          await this.retry(run, reason, status.state === 'yielded');
        else await this.finish(run, 'failed', reason); // A data/audit refusal is not a transient failure.
        return;
      }
    }
    if (Date.now() - Math.max(run.lastProgressAt, run.attemptStartedAt) > STALL_MS) {
      // A live container that has not advanced for twenty minutes is this run failing, whether or not it
      // advanced earlier in the attempt — the one retry that always spends the budget.
      await this.retry(run, readError, false, true);
      return;
    }
    await container.setInactivityTimeout(10 * MINUTE);
  }
}
export { DeclarationCorpus } from './declaration-corpus';
