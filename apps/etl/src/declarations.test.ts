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
  const owner = (status?: string) => {
    env.DECLARATIONS_RUN = (
      status
        ? { get: async () => ({ status: async () => ({ status }) }) }
        : {
            get: async () => {
              throw new Error('lookup failed');
            },
          }
    ) as never;
  };
  return { job, container, run, answer, resume, owner };
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
  for (let attempt = 1; attempt <= 6; attempt++) {
    f.container.running = false;
    await f.job().alarm();
    if (attempt < 6) await f.resume();
  }
  // A container that never answers cannot be told from one the platform never provided, so the bound is
  // the short cold-start one — the run still ends after three silent attempts.
  expect(f.run()).toMatchObject({
    state: 'failed',
    reason: expect.stringContaining('Container gave no sign of life'),
  });
  expect(f.container.start).toHaveBeenCalledTimes(6);
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

it('stops the container when the workflow instance that started the run is gone', async () => {
  const f = fixture();
  await f.job().startRun('workflow-1');
  await f.job().alarm();
  f.owner('running'); // A live owner changes nothing.
  await f.job().alarm();
  expect(f.run()).toMatchObject({ state: 'running' });
  f.owner(); // A failed lookup says nothing, so the run carries on.
  await f.job().alarm();
  expect(f.run()).toMatchObject({ state: 'running' });
  f.owner('terminated');
  await f.job().alarm();
  expect(f.run()).toMatchObject({
    state: 'failed',
    reason: 'The workflow instance that started this run is gone',
  });
  expect(f.container.running).toBe(false);
});

it('retries a yield at any stage, and keeps a data refusal final', async () => {
  const f = fixture();
  await f.job().startRun('workflow-yield');
  await f.job().alarm();
  // An accepted checkpoint mid-extract: progress advanced, so the attempt is not counted as failed.
  f.answer({ state: 'yielded', stage: 'extract', completed: 5000, reason: 'container stop' });
  await f.job().alarm();
  expect(f.run()).toMatchObject({ state: 'running', failures: 0, completed: 5000 });
  await f.resume();
  // A yield that advanced nothing still costs an attempt.
  f.answer({ state: 'yielded', stage: 'extract', completed: 1, reason: 'container stop' });
  await f.job().alarm();
  expect(f.run()).toMatchObject({ state: 'running', failures: 1 });
  await f.resume();
  // A refusal is not a yield: the run ends.
  f.answer({ state: 'failed', stage: 'audit', completed: 1, reason: 'audit findings' });
  await f.job().alarm();
  expect(f.run()).toMatchObject({ state: 'failed', reason: 'audit findings' });
});

// „There is no container instance that can be provided" is the platform declining, not this run going
// wrong. Spending the failure budget on it ended a run after about fourteen minutes, and the weekly one
// then waits until the next Sunday for data nobody fetched.
it('waits out a platform capacity refusal instead of spending the failure budget', async () => {
  const f = fixture();
  f.container.start.mockImplementation(() => {
    throw new Error(
      'There is no container instance that can be provided to this Durable Object, try again later',
    );
  });
  await f.job().startRun('workflow-capacity');
  for (let i = 0; i < 4; i++) await f.resume();
  expect(f.run().state).toBe('running');
  expect(f.run().failures ?? 0).toBe(0); // the failure budget is untouched
  expect(f.run().capacityWaits).toBe(4);
  // The wait grows, and far past the two minutes a normal failure would take.
  expect(f.run().retryAt - Date.now()).toBeGreaterThan(20 * 60_000);

  // An answer from the container is the only proof an instance really ran, so that is where the
  // waiting ends — not at a `start()` the platform merely accepted.
  f.container.start.mockImplementation(() => {
    f.container.running = true;
  });
  await f.resume();
  expect(f.run().capacityWaits).toBe(4); // started, but still silent
  f.answer({ stage: 'fetch', completed: 5 });
  await f.job().alarm();
  expect(f.run().capacityWaits).toBe(0);
});

// The shortage reaches the coordinator as „Container interrupted", not as an exception from start():
// the platform accepts the start and then no instance appears. One name, two different events — and
// counting both as failures ended a run that had already fetched two hundred thousand documents.
it('tells a container that broke from one that never appeared', async () => {
  const f = fixture();
  await f.job().startRun('workflow-silent');
  // The instance never comes up: `start()` is accepted, nothing answers /status.
  f.container.start.mockImplementation(() => {});
  await f.job().alarm(); // attempt 1 is started; nothing ever appears
  await f.job().alarm(); // silence noticed → first wait
  await f.resume(); // attempt 2 is started
  await f.job().alarm(); // second wait
  expect(f.run().state).toBe('running');
  expect(f.run().failures ?? 0).toBe(0);
  expect(f.run().capacityWaits).toBe(2);

  // A container that ANSWERED and then died is this run breaking, and spends the failure budget.
  const g = fixture();
  await g.job().startRun('workflow-broke');
  await g.job().alarm(); // the container starts and is running
  g.answer({ stage: 'fetch', completed: 10 });
  await g.job().alarm(); // it answers /status — proof an instance really ran
  g.container.running = false;
  await g.job().alarm();
  // It spoke, so its death is this run's to answer for: the ordinary retry, not the capacity wait.
  expect(g.run().reason).toBe('Container interrupted');
  expect(g.run().capacityWaits ?? 0).toBe(0);
  expect(g.run().retryAt - Date.now()).toBeLessThan(5 * 60_000);
});

// A run that has never seen a live container could equally be a broken image, so the patience is shorter
// than for one that has — but long enough to ride out an evening when the platform is busy.
it('gives up on a run that never gets a container, but not before it has waited', async () => {
  const f = fixture();
  await f.job().startRun('workflow-cold');
  f.container.start.mockImplementation(() => {});
  await f.job().alarm();
  for (let i = 0; i < 5; i++) {
    await f.job().alarm();
    expect(f.run().state, `изчакване ${i + 1}`).toBe('running');
    await f.resume();
  }
  await f.job().alarm();
  expect(f.run().state).toBe('failed');
  expect(f.run().reason).toMatch(/Container gave no sign of life/);
});
