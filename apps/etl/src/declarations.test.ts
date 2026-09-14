import { afterEach, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('cloudflare:workers')>()),
  exports: { DeclarationCorpus: () => ({}) },
}));
import { DeclarationContainer } from './declarations';
afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-14T00:00:00Z'));
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
    interceptOutboundHttp: vi.fn(),
    getTcpPort: () => ({ fetch: async () => Response.json(status) }),
  };
  const storage = {
    get: async (key: string) => structuredClone(records.get(key)),
    put: async (key: string, value: unknown) => {
      records.set(key, structuredClone(value));
    },
    setAlarm: vi.fn(),
    transaction: async <T>(fn: (s: unknown) => Promise<T>): Promise<T> => fn(storage),
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
    ].map((k) => [k, 'test']),
  );
  env.DECLARATIONS_CORPUS = {} as never;
  const job = () => new DeclarationContainer({ container, storage } as never, env);
  const run = () => records.get('run');
  const answer = (extra: object) => {
    status = { ...run(), ...extra };
  };
  const resume = async () => {
    vi.setSystemTime(run().retryAt);
    await job().alarm();
  };
  return { job, container, run, answer, resume };
}

it('survives two yields and DO eviction, keeps one logical run, and accepts only audited publication', async () => {
  const f = fixture();
  const first = await f.job().startRun('workflow-1');
  expect(await f.job().startRun('workflow-1')).toEqual(first);
  await f.job().alarm();
  expect(f.container.start).toHaveBeenCalledOnce();
  expect(f.container.interceptOutboundHttp).toHaveBeenCalledWith('declarations.r2', {});
  for (const completed of [100, 200]) {
    f.answer({ state: 'yielded', stage: 'fetch', completed, reason: 'time slice' });
    await f.job().alarm();
    expect(f.run()).toMatchObject({ state: 'running', runId: first.runId, completed, failures: 0 });
    await f.resume(); // A newly constructed DO reads the persisted state.
  }
  expect(f.run().attempt).toBe(3);
  expect(
    f.container.start.mock.calls.every(
      (args) =>
        (args as unknown as [{ env: { SIGMA_RUN_ID: string } }])[0].env.SIGMA_RUN_ID ===
        first.runId,
    ),
  ).toBe(true);
  f.answer({ state: 'complete', stage: 'reindex', audit: true, published: true });
  await f.job().alarm();
  expect(f.run()).toMatchObject({ state: 'complete', audit: true, published: true });
  expect(f.container.running).toBe(false);
  expect((await f.job().startRun('workflow-1')).runId).toBe(first.runId);
  expect(f.container.start).toHaveBeenCalledTimes(3);
  expect((await f.job().startRun('workflow-2')).runId).not.toBe(first.runId);
});

it('bounds automatic retries when containers repeatedly stop without advancing', async () => {
  const f = fixture();
  await f.job().startRun();
  await f.job().alarm();
  for (let attempt = 1; attempt <= 3; attempt++) {
    f.container.running = false;
    await f.job().alarm();
    if (attempt < 3) await f.resume();
  }
  expect(f.run()).toMatchObject({
    state: 'failed',
    reason: expect.stringContaining('3 attempts without progress'),
  });
  expect(f.container.start).toHaveBeenCalledTimes(3);
});

it('allows useful progress beyond six hours and recovers a stalled attempt', async () => {
  const f = fixture();
  await f.job().startRun();
  await f.job().alarm();
  vi.setSystemTime(Date.now() + 7 * 3600000);
  f.answer({ completed: 500 });
  await f.job().alarm();
  expect(f.run().state).toBe('running');
  vi.setSystemTime(Date.now() + 21 * 60000);
  await f.job().alarm();
  expect(f.run().retryAt).toBeGreaterThan(Date.now());
  await f.resume();
  expect(f.run()).toMatchObject({ attempt: 2, completed: 500, state: 'running' });
});

it('surfaces audit failures and refuses a stale container instead of publishing', async () => {
  const f = fixture();
  await f.job().startRun();
  await f.job().alarm();
  f.answer({ state: 'failed', stage: 'audit', reason: 'source hash changed' });
  await f.job().alarm();
  expect(f.run()).toMatchObject({ state: 'failed', reason: 'source hash changed' });
  await f.job().startRun();
  await f.job().alarm();
  f.answer({ state: 'complete', runId: 'different', audit: true, published: true });
  await f.job().alarm();
  expect(f.run()).toMatchObject({ state: 'failed', reason: 'Container run or attempt mismatch' });
});
