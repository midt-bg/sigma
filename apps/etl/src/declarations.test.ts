import { expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));
import { DeclarationContainer } from './declarations';
it('deduplicates live starts, records completion, restores checkpoints and detects interruption', async () => {
  const records = new Map();
  let status: unknown;
  const container = {
    running: false,
    start: vi.fn(() => {
      container.running = true;
    }),
    destroy: vi.fn(async () => {
      container.running = false;
    }),
    setInactivityTimeout: vi.fn(),
    getTcpPort: () => ({ fetch: async () => Response.json(status) }),
  };
  const ctx = {
    container,
    blockConcurrencyWhile: (fn: () => unknown) => fn(),
    storage: {
      get: async (key: string) => records.get(key),
      put: async (key: string, value: unknown) => {
        records.set(key, value);
      },
      setAlarm: vi.fn(),
    },
  };
  const env = Object.fromEntries(
    [
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
      'SIGMA_D1_ID',
      'SIGMA_D1_NAME',
      'SIGMA_SHIP_ENV',
      'DECLARATIONS_BUCKET',
      'SUPPRESSION_SALT',
      'SUPPRESSION_KEY_VERSION',
    ].map((k) => [k, 'test']),
  );
  env.DECLARATIONS_CORPUS = { get: async () => ({ text: async () => '{"folders":[]}' }) } as never;
  const job = new DeclarationContainer(ctx as never, env);
  const first = await job.startRun();
  expect(await job.getRun()).toEqual(first);
  expect(await job.startRun()).toEqual(first);
  expect(container.start).toHaveBeenCalledOnce();
  expect(container.start.mock.calls[0]).toMatchObject([
    { env: { DECLARATIONS_RESTORE: '{"folders":[]}', SUPPRESSION_SALT: 'test' } },
  ]);
  status = { ...first, state: 'complete' };
  await job.alarm();
  expect(records.get('run').state).toBe('complete');
  expect((await job.getRun())?.state).toBe('complete');
  expect(container.running).toBe(false);
  const second = await job.startRun();
  expect(second.runId).not.toBe(first.runId);
  container.running = false;
  await job.alarm();
  expect(records.get('run').state).toBe('interrupted');
  await job.startRun();
  records.get('run').startedAt = Date.now() - 7 * 3600000;
  await job.alarm();
  expect(records.get('run')).toMatchObject({ state: 'failed', reason: 'deadline' });
  expect(container.running).toBe(false);
});
