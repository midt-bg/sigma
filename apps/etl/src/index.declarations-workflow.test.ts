import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import worker, { DeclarationsWorkflow, DECLARATIONS_CRON, RebuildWorkflow } from './index';
import type { Env } from './index';

// `scheduled` tells the weekly tick from the six-hourly one by comparing the platform's cron string to
// DECLARATIONS_CRON, so the deployed schedule and the constant must be the same string — and Sunday must
// be spelled `7`, because the Cloudflare API rejects `0 3 * * 0` and the deploy dies at the trigger step.
it('deploys the very cron the weekly branch compares against', () => {
  const toml = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../wrangler.toml'),
    'utf8',
  );
  const crons = /^crons = \[(.*)\]$/m.exec(toml)?.[1];
  expect(crons, 'no crons in wrangler.toml').toBeDefined();
  expect(crons).toContain(`"${DECLARATIONS_CRON}"`);
  expect(DECLARATIONS_CRON.split(' ').at(-1), 'Sunday is 7 for the Cloudflare API').not.toBe('0');
});

// dev and the deployed Workers must run the same compatibility date: the declarations container reaches
// the corpus through `exports` from `cloudflare:workers`, which simply is not there on an older date. A
// dev config that runs ahead proves a feature the deployed Worker cannot use — staging died on exactly
// that, with the corpus entrypoint reported as "not a function".
it('runs dev and the deployed Worker on one compatibility date', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const toml = readFileSync(resolve(dir, '../wrangler.toml'), 'utf8');
  const dev = readFileSync(resolve(dir, '../wrangler.dev.jsonc'), 'utf8');
  const deployed = /^compatibility_date = "([\d-]+)"$/m.exec(toml)?.[1];
  const local = /"compatibility_date":\s*"([\d-]+)"/.exec(dev)?.[1];
  expect(deployed, 'no compatibility_date in wrangler.toml').toBeDefined();
  expect(local, 'no compatibility_date in wrangler.dev.jsonc').toBeDefined();
  expect(deployed).toBe(local);
});

it('starts one declarations run and waits for the container outcome', async () => {
  const startRun = vi.fn(async () => ({ runId: 'run-1', state: 'running' }));
  const getRun = vi
    .fn()
    .mockResolvedValueOnce({ runId: 'run-1', state: 'running' })
    .mockResolvedValue({ runId: 'run-1', state: 'complete' });
  const env = { DECLARATIONS: { getByName: () => ({ startRun, getRun }) } };
  const step = { do: async (_name: string, fn: () => unknown) => fn(), sleep: vi.fn() };
  const run = (overrides = {}) =>
    new DeclarationsWorkflow({} as never, { ...env, ...overrides } as never).run(
      { instanceId: 'workflow-1' } as never,
      step as never,
    );
  await expect(run({ DECLARATIONS: undefined })).rejects.toThrow('not bound');
  expect(startRun).not.toHaveBeenCalled();
  await expect(run()).resolves.toMatchObject({ runId: 'run-1', state: 'complete' });
  expect(getRun).toHaveBeenCalledTimes(2);
  expect(startRun).toHaveBeenCalledWith('workflow-1');
  expect(step.sleep).toHaveBeenCalledWith('wait-0', '5 minutes');
  getRun.mockResolvedValue({ runId: 'run-1', state: 'failed', reason: 'deadline' });
  await expect(run()).rejects.toThrow('Declaration run failed: deadline');
  getRun.mockResolvedValue(null);
  await expect(run()).rejects.toThrow('Declaration run changed');
  getRun.mockResolvedValue({ runId: 'run-2', state: 'running' });
  await expect(run()).rejects.toThrow('Declaration run changed');
});

it('the weekly cron starts only the declarations; every other tick refreshes procurement and the register', async () => {
  const create = vi.fn().mockResolvedValue({ id: 'wf' });
  const startRun = vi.fn().mockResolvedValue({ runId: 'declarations' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const env = {
    REFRESH: { create },
    REGISTRY: { create },
    REGISTRY_API_BASE_URL: 'https://published.test',
    DECLARATIONS_ENABLED: 'true',
    DECLARATIONS: { getByName: () => ({ startRun, getRun: async () => null }) },
  } as unknown as Env;
  await worker.scheduled({ cron: DECLARATIONS_CRON } as never, env);
  expect(startRun).toHaveBeenCalledOnce();
  expect(create).not.toHaveBeenCalled();
  await worker.scheduled({ cron: '0 */6 * * *' } as never, env);
  expect(create).toHaveBeenCalledTimes(2);
  expect(startRun).toHaveBeenCalledOnce();
  // Disabled declarations make the weekly tick a no-op rather than a failure.
  await worker.scheduled(
    { cron: DECLARATIONS_CRON } as never,
    { ...env, DECLARATIONS_ENABLED: 'false' } as Env,
  );
  expect(startRun).toHaveBeenCalledOnce();
  log.mockRestore();
});

it('passes the operator resume flag to the rebuild', async () => {
  const startRun = vi.fn(async () => ({ runId: 'rb', state: 'running' }));
  const getRun = vi.fn().mockResolvedValue({ runId: 'rb', state: 'complete', stage: 'verify' });
  const env = {
    DECLARATIONS: { getByName: () => ({ startRun, getRun }) },
  } as unknown as Env;
  const step = {
    do: async (_name: string, fn: () => Promise<unknown>) => fn(),
    sleep: async () => {},
  };
  await new RebuildWorkflow({} as never, env).run(
    {
      instanceId: 'wf-resume',
      payload: { targetName: 'sigma-green', targetId: 'x', resume: true },
    } as never,
    step as never,
  );
  expect(startRun).toHaveBeenCalledWith('wf-resume', {
    name: 'sigma-green',
    id: 'x',
    resume: true,
  });
});

it('starts a rebuild of the named idle slot and waits for it', async () => {
  const startRun = vi.fn(async () => ({ runId: 'rb', state: 'running' }));
  const getRun = vi.fn().mockResolvedValue({ runId: 'rb', state: 'complete', stage: 'verify' });
  const getByName = vi.fn(() => ({ startRun, getRun }));
  const step = { do: async (_name: string, fn: () => unknown) => fn(), sleep: vi.fn() };
  const run = (payload?: object) =>
    new RebuildWorkflow({} as never, { DECLARATIONS: { getByName } } as never).run(
      { instanceId: 'wf', payload } as never,
      step as never,
    );
  await expect(
    new RebuildWorkflow({} as never, {} as never).run(
      {
        instanceId: 'wf',
        payload: { targetName: 'sigma-idle', targetId: 'x' },
      } as never,
      step as never,
    ),
  ).rejects.toThrow('not bound');
  await expect(run()).rejects.toThrow('Name the idle slot');
  await expect(run({ targetName: 'sigma-idle', targetId: 'x' })).resolves.toMatchObject({
    state: 'complete',
  });
  expect(getByName).toHaveBeenCalledWith('rebuild');
  expect(startRun).toHaveBeenCalledWith('wf', { name: 'sigma-idle', id: 'x' });

  getRun
    .mockReset()
    .mockResolvedValueOnce({ runId: 'rb', state: 'running', stage: 'import' })
    .mockResolvedValue({ runId: 'rb', state: 'complete', stage: 'verify' });
  await expect(run({ targetName: 'sigma-idle', targetId: 'x' })).resolves.toMatchObject({
    state: 'complete',
  });
  expect(step.sleep).toHaveBeenCalledWith('wait-1', '10 minutes');

  getRun.mockResolvedValue(null);
  await expect(run({ targetName: 'sigma-idle', targetId: 'x' })).rejects.toThrow(
    'Rebuild run changed',
  );
  getRun.mockResolvedValue({ runId: 'another-run', state: 'running' });
  await expect(run({ targetName: 'sigma-idle', targetId: 'x' })).rejects.toThrow(
    'Rebuild run changed',
  );
  getRun.mockResolvedValue({ runId: 'rb', state: 'failed' });
  await expect(run({ targetName: 'sigma-idle', targetId: 'x' })).rejects.toThrow(/Rebuild failed:/);
  getRun.mockResolvedValue({ runId: 'rb', state: 'failed', reason: 'counts' });
  await expect(run({ targetName: 'sigma-idle', targetId: 'x' })).rejects.toThrow(
    'Rebuild failed: counts',
  );
});

// A Workflow instance is capped at 1,024 steps on the free plan and each poll costs two, so an
// unbounded wait ends in an opaque platform failure rather than a sentence naming what happened.
it('gives up on a run that never finishes, with its own message', async () => {
  const startRun = vi.fn(async () => ({ runId: 'run-1', state: 'running' }));
  const getRun = vi.fn(async () => ({ runId: 'run-1', state: 'running' }));
  const sleeps: string[] = [];
  const step = {
    do: async (_name: string, fn: () => unknown) => fn(),
    sleep: async (name: string) => void sleeps.push(name),
  };
  await expect(
    new DeclarationsWorkflow(
      {} as never,
      {
        DECLARATIONS: { getByName: () => ({ startRun, getRun }) },
      } as never,
    ).run({ instanceId: 'workflow-1' } as never, step as never),
  ).rejects.toThrow(/still running after 1440 minutes/);
  expect(sleeps.length).toBe(288); // 24 hours at five minutes, well under the step cap
});
