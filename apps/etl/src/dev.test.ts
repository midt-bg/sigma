import { expect, it, vi } from 'vitest';
import { DevDeclarationsWorkflow } from './dev';

it('keeps manual declaration runs in dev and waits for the actual container outcome', async () => {
  const startRun = vi.fn(async () => ({ runId: 'run-1', state: 'running' }));
  const getRun = vi
    .fn()
    .mockResolvedValueOnce({ runId: 'run-1', state: 'running' })
    .mockResolvedValue({ runId: 'run-1', state: 'complete' });
  const env = {
    SIGMA_D1_ID: '713b98fa-6ab5-45f3-81c4-119f4c0907d6',
    SIGMA_D1_NAME: 'sigma-dev',
    SIGMA_SHIP_ENV: 'dev',
    DECLARATIONS_BUCKET: 'sigma-declarations-dev',
    DECLARATIONS: { getByName: () => ({ startRun, getRun }) },
  };
  const step = { do: async (_name: string, fn: () => unknown) => fn(), sleep: vi.fn() };
  const run = (overrides = {}) =>
    new DevDeclarationsWorkflow({} as never, { ...env, ...overrides } as never).run(
      { instanceId: 'workflow-1' } as never,
      step as never,
    );
  await expect(run({ SIGMA_D1_NAME: 'sigma-stage' })).rejects.toThrow('isolated dev');
  await expect(run({ SIGMA_D1_ID: 'another-database' })).rejects.toThrow('isolated dev');
  expect(startRun).not.toHaveBeenCalled();
  await expect(run()).resolves.toMatchObject({ runId: 'run-1', state: 'complete' });
  expect(getRun).toHaveBeenCalledTimes(2);
  expect(startRun).toHaveBeenCalledWith('workflow-1');
  expect(step.sleep).toHaveBeenCalledWith('wait-0', '5 minutes');
  getRun.mockResolvedValue({ runId: 'run-1', state: 'failed', reason: 'deadline' });
  await expect(run()).rejects.toThrow('failed: deadline');
  getRun.mockResolvedValue({ runId: 'another-run', state: 'complete' });
  await expect(run()).rejects.toThrow('run changed');
});

it('stops a manual run that disappears or fails without a reason', async () => {
  const getRun = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValue({ runId: 'run-1', state: 'failed' });
  const env = {
    SIGMA_D1_ID: '713b98fa-6ab5-45f3-81c4-119f4c0907d6',
    SIGMA_D1_NAME: 'sigma-dev',
    SIGMA_SHIP_ENV: 'dev',
    DECLARATIONS_BUCKET: 'sigma-declarations-dev',
    DECLARATIONS: {
      getByName: () => ({ startRun: async () => ({ runId: 'run-1', state: 'running' }), getRun }),
    },
  };
  const step = { do: async (_name: string, fn: () => unknown) => fn(), sleep: async () => {} };
  const run = () =>
    new DevDeclarationsWorkflow({} as never, env as never).run(
      { instanceId: 'workflow-1' } as never,
      step as never,
    );
  await expect(run()).rejects.toThrow('Declaration run changed');
  await expect(run()).rejects.toThrow(/^Declaration run failed: $/);
});
