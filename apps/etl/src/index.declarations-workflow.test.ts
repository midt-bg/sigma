import { expect, it, vi } from 'vitest';
import worker, { DeclarationsWorkflow, DECLARATIONS_CRON } from './index';
import type { Env } from './index';

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
    DECLARATIONS: { getByName: () => ({ startRun }) },
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
