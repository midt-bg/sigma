import { afterEach, describe, expect, it, vi } from 'vitest';
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

it('keeps replay below the high-water mark alive but still detects a real stall', async () => {
  const f = fixture();
  await f.job().startRun();
  await f.job().alarm();
  f.answer({ stage: 'extract', completed: 180000 });
  await f.job().alarm();
  f.container.running = false;
  await f.job().alarm();
  await f.resume();
  for (const completed of [1000, 2000, 3000]) {
    vi.setSystemTime(Date.now() + 10 * 60000);
    f.answer({ stage: 'extract', completed });
    await f.job().alarm();
    expect(f.run()).toMatchObject({ state: 'running', completed: 180000, attempt: 2 });
    expect(f.run().retryAt).toBeUndefined();
  }
  vi.setSystemTime(Date.now() + 21 * 60000);
  await f.job().alarm();
  expect(f.run().retryAt).toBeGreaterThan(Date.now());
  expect(f.run().failures).toBe(1); // Replay does not count as new durable progress.
});

describe('declaration coordinator guards and status handling', () => {
  const started = async () => {
    const f = fixture();
    await f.job().startRun();
    await f.job().alarm();
    return f;
  };

  it('refuses to start without its bindings and settings', async () => {
    const bare = (env: object, container: unknown = {}) =>
      new DeclarationContainer({ container, storage: {} } as never, env as never);
    const binding = 'Declaration container and corpus binding are required';
    await expect(bare({}).startRun()).rejects.toThrow(binding);
    await expect(bare({ DECLARATIONS_CORPUS: {} }, null).startRun()).rejects.toThrow(binding);
    await expect(
      bare({ DECLARATIONS_CORPUS: {}, CLOUDFLARE_API_TOKEN: 'test' }).startRun(),
    ).rejects.toThrow('Missing declaration setting: CLOUDFLARE_ACCOUNT_ID');
  });

  it('accepts only a sane request ID and never adopts a container it did not start', async () => {
    const f = fixture();
    await expect(f.job().startRun('')).rejects.toThrow('Invalid request ID');
    await expect(f.job().startRun('x'.repeat(257))).rejects.toThrow('Invalid request ID');
    f.container.running = true;
    await expect(f.job().startRun('workflow-1')).rejects.toThrow(
      'Unaccounted active declaration container',
    );
    expect(f.run()).toBeUndefined();
    f.container.running = false;
    expect((await f.job().startRun('x'.repeat(256))).requestId).toHaveLength(256);
  });

  it('ignores alarms without a live run and waits out a retry backoff', async () => {
    const f = fixture();
    await f.job().alarm();
    expect(f.run()).toBeUndefined();
    await f.job().startRun();
    await f.job().alarm();
    f.container.running = false;
    await f.job().alarm(); // interrupted: retry in two minutes
    const waiting = f.run();
    vi.setSystemTime(waiting.retryAt - 1);
    await f.job().alarm(); // fired early
    expect(f.run()).toEqual(waiting);
    expect(f.job()['ctx'].storage.setAlarm).toHaveBeenLastCalledWith(waiting.retryAt);
    expect(f.container.start).toHaveBeenCalledOnce();
    await f.resume();
    expect(f.run()).toMatchObject({ attempt: 2, state: 'running' });
    expect(f.container.start).toHaveBeenCalledTimes(2);
    // A finished run's leftover alarm starts nothing.
    f.answer({ state: 'failed', stage: 'load', reason: 'refused' });
    await f.job().alarm();
    await f.job().alarm();
    expect(f.run()).toMatchObject({ state: 'failed', attempt: 2 });
    expect(f.container.start).toHaveBeenCalledTimes(2);
  });

  it('retries a container that fails to start, with its reason', async () => {
    const f = fixture();
    await f.job().startRun();
    f.container.start.mockImplementationOnce(() => {
      throw new Error('no capacity');
    });
    await f.job().alarm();
    expect(f.run()).toMatchObject({
      state: 'running',
      attempt: 1,
      failures: 1,
      reason: 'no capacity',
      retryAt: Date.now() + 2 * 60_000,
    });
    expect(f.container.destroy).toHaveBeenCalledOnce();
    f.container.interceptOutboundHttp.mockRejectedValueOnce('opaque');
    await f.resume();
    expect(f.run()).toMatchObject({
      attempt: 2,
      failures: 2,
      reason: 'Container start failed',
      retryAt: Date.now() + 4 * 60_000,
    });
  });

  it('treats an unreadable status as no progress until the stall limit', async () => {
    const f = await started();
    f.container.getTcpPort = () => ({
      fetch: async () => new Response(null, { status: 503 }),
    });
    vi.setSystemTime(Date.now() + 19 * 60_000);
    await f.job().alarm();
    expect(f.run()).toMatchObject({ state: 'running', failures: 0 });
    expect(f.run().retryAt).toBeUndefined();
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await f.job().alarm();
    expect(f.run()).toMatchObject({ failures: 1, reason: 'Container status returned 503' });
    await f.resume();
    f.container.getTcpPort = () => ({
      fetch: async () => {
        throw 'socket closed';
      },
    });
    vi.setSystemTime(Date.now() + 21 * 60_000);
    await f.job().alarm();
    expect(f.run()).toMatchObject({ failures: 2, reason: 'Container status unavailable' });
  });

  it('fails a run on malformed progress', async () => {
    for (const bad of [
      { stage: 'deploy' },
      { completed: -1 },
      { completed: 1.5 },
      { state: 'paused' },
    ]) {
      const f = await started();
      f.answer(bad);
      await f.job().alarm();
      expect(f.run()).toMatchObject({ state: 'failed', reason: 'Invalid container progress' });
      expect(f.container.running).toBe(false);
    }
  });

  it('records a total only while it bounds the progress', async () => {
    const f = await started();
    f.answer({ stage: 'extract', completed: 10, total: 100 });
    await f.job().alarm();
    expect(f.run()).toMatchObject({ stage: 'extract', completed: 10, total: 100 });
    f.answer({ stage: 'extract', completed: 20, total: 5 });
    await f.job().alarm();
    expect(f.run()).toMatchObject({ completed: 20 });
    expect(f.run()).not.toHaveProperty('total');
  });

  it('fails a completion without receipts and names a bare refusal by its stage', async () => {
    const f = await started();
    f.answer({ state: 'complete', stage: 'reindex', audit: true });
    await f.job().alarm();
    expect(f.run()).toMatchObject({ state: 'failed', reason: 'Missing audit/publication receipt' });
    expect(f.run()).not.toHaveProperty('published');
    await f.job().startRun();
    await f.job().alarm();
    f.answer({ state: 'failed', stage: 'load' });
    await f.job().alarm();
    expect(f.run()).toMatchObject({ state: 'failed', reason: 'load failed' });
  });
});

it('rebuilds only an idle slot, passes both slots to the container and follows the rebuild stages', async () => {
  const f = fixture();
  const idle = { name: 'sigma-idle', id: '11111111-2222-3333-4444-555555555555' };
  await expect(f.job().startRun('r', { name: 'test', id: idle.id })).rejects.toThrow('idle slot');
  await expect(f.job().startRun('r', { name: idle.name, id: 'not-an-id' })).rejects.toThrow(
    'idle slot',
  );
  const run = await f.job().startRun('r', idle);
  expect(run).toMatchObject({ target: idle, stage: 'import' });
  await f.job().alarm();
  const env = (f.container.start.mock.calls[0] as unknown as [{ env: Record<string, string> }])[0]
    .env;
  expect(env).toMatchObject({
    SIGMA_D1_NAME: idle.name,
    SIGMA_D1_ID: idle.id,
    SIGMA_LIVE_D1_NAME: 'test',
    SIGMA_LIVE_D1_ID: 'test',
    SIGMA_REBUILD: '1',
  });
  for (const [stage, completed] of [
    ['registry', 5],
    ['extract', 10],
    ['ship', 3],
  ] as const) {
    f.answer({ state: 'running', stage, completed });
    await f.job().alarm();
    expect(f.run()).toMatchObject({ stage, completed });
  }
  // A network stage is retried; the build restarts in a new attempt.
  f.answer({ state: 'failed', stage: 'registry', completed: 3, reason: 'timeout' });
  await f.job().alarm();
  expect(f.run()).toMatchObject({ state: 'running', reason: 'timeout' });
  await f.resume();
  f.answer({ state: 'complete', stage: 'verify', audit: true, published: true });
  await f.job().alarm();
  expect(f.run()).toMatchObject({ state: 'complete', target: idle });
});
