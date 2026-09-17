import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workflows', () => ({ NonRetryableError: class extends Error {} }));
vi.mock('../../../scripts/refresh-slice.sql', () => ({ default: '' }));
vi.mock('../../../scripts/work-staging-schema.sql', () => ({ default: '' }));
const { client, reg } = vi.hoisted(() => ({
  client: { changes: vi.fn(), deed: vi.fn() },
  reg: {
    acquireRegistryLease: vi.fn(),
    completeEntryBaseline: vi.fn(),
    renewRegistryLease: vi.fn(),
    releaseRegistryLease: vi.fn(),
    seedEntryPasses: vi.fn(),
    nextEntryPass: vi.fn(),
    prepareEntryBaseline: vi.fn(),
    recordEntryPage: vi.fn(),
    deferPortal: vi.fn(),
    deferDeed: vi.fn(),
    deferXml: vi.fn(),
    queueNewWinners: vi.fn(),
    nextQueued: vi.fn(),
    storeDeed: vi.fn(),
    derivePublicOwnership: vi.fn(),
  },
}));
vi.mock('@sigma/ingest', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  registryClient: () => client,
}));
vi.mock('./registry', () => reg);
import { RegistryError } from '@sigma/ingest';
import { NonRetryableError } from 'cloudflare:workflows';
import worker, { RegistryWorkflow, type Env } from './index';
function run() {
  const wf = new RegistryWorkflow(
    {} as ExecutionContext,
    { DB: {}, REGISTRY_API_BASE_URL: 'https://published.test' } as Env,
  );
  return wf.run(
    {
      instanceId: 'run',
      payload: { today: '2026-09-13', paceMs: 0, portalPaceMs: 0 },
      timestamp: new Date(),
    } as never,
    { do: async (_name: string, fn: () => unknown) => fn(), sleep: async () => {} } as never,
  );
}
beforeEach(() => {
  for (const f of [...Object.values(client), ...Object.values(reg)]) f.mockReset();
  reg.acquireRegistryLease.mockResolvedValue(true);
  reg.completeEntryBaseline.mockResolvedValue(true);
  reg.prepareEntryBaseline.mockResolvedValue('ready');
  reg.renewRegistryLease.mockResolvedValue(true);
  reg.nextEntryPass.mockResolvedValue(null);
  reg.queueNewWinners.mockResolvedValue(1);
  reg.nextQueued.mockResolvedValueOnce(['111111111']).mockResolvedValue([]);
  client.deed.mockResolvedValue({ status: 'ok', deed: {} });
  reg.storeDeed.mockResolvedValue({ roles: 2, persons: 1 });
});
describe('published registry Workflow', () => {
  it('refuses existing data without a verified full-import marker', async () => {
    reg.prepareEntryBaseline.mockResolvedValue('missing-marker');
    await expect(run()).rejects.toThrow('verified full-import marker');
    expect(client.changes).not.toHaveBeenCalled();
    expect(client.deed).not.toHaveBeenCalled();
    expect(reg.releaseRegistryLease).toHaveBeenCalled();
  });
  it('builds an empty baseline before it begins daily portal passes', async () => {
    reg.prepareEntryBaseline.mockResolvedValue('building');
    expect(await run()).toMatchObject({ read: 1, roles: 2 });
    expect(reg.seedEntryPasses).not.toHaveBeenCalled();
    expect(client.changes).not.toHaveBeenCalled();
    expect(reg.completeEntryBaseline).toHaveBeenCalledWith({}, 'run', expect.any(String));
  });
  it('reads queued deeds independently of a portal refusal and preserves the pass', async () => {
    reg.nextEntryPass.mockResolvedValue({ day: '2026-09-12', delay: 1, next_page: 2 });
    client.changes.mockRejectedValue(new Error('portal down'));
    expect(await run()).toMatchObject({ read: 1, roles: 2 });
    expect(reg.deferPortal).toHaveBeenCalled();
    expect(reg.recordEntryPage).not.toHaveBeenCalled();
    expect(reg.releaseRegistryLease).toHaveBeenCalled();
  });
  it('never stores a response after losing the lease during network I/O', async () => {
    client.deed.mockImplementation(async () => {
      reg.renewRegistryLease.mockResolvedValue(false);
      return { status: 'ok', deed: {} };
    });
    await expect(run()).rejects.toThrow('lease lost');
    expect(reg.storeDeed).not.toHaveBeenCalled();
  });
  it('retains failed deeds and continues to other queued winners', async () => {
    reg.nextQueued
      .mockReset()
      .mockResolvedValueOnce(['111111111', '222222222'])
      .mockResolvedValue([]);
    client.deed.mockRejectedValueOnce(new Error('timeout'));
    expect(await run()).toMatchObject({ read: 2, roles: 2 });
    expect(reg.deferDeed).toHaveBeenCalled();
    expect(reg.storeDeed).toHaveBeenCalledTimes(1);
  });
  it('defers the XML service on 429 before asking for another partida', async () => {
    reg.nextQueued
      .mockReset()
      .mockResolvedValueOnce(['111111111', '222222222'])
      .mockResolvedValue([]);
    client.deed.mockRejectedValueOnce(new RegistryError('rate limited', 429, 600000));
    await run();
    expect(client.deed).toHaveBeenCalledOnce();
    expect(reg.deferXml).toHaveBeenCalled();
    expect(reg.storeDeed).not.toHaveBeenCalled();
  });
  it('starts the register even when the procurement start fails', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'registry' });
    await expect(
      worker.scheduled(
        { cron: '0 */6 * * *' } as never,
        {
          REFRESH: {
            create: async () => {
              throw Error('failed');
            },
          },
          REGISTRY: { create },
          REGISTRY_API_BASE_URL: 'https://published.test',
        } as unknown as Env,
      ),
    ).rejects.toThrow('scheduled starts failed');
    expect(create).toHaveBeenCalledOnce();
  });
});

describe('published registry Workflow — configuration, pacing and failure paths', () => {
  const PAYLOAD = { today: '2026-09-13', paceMs: 0, portalPaceMs: 0 };
  const T0 = Date.parse('2026-09-13T22:30:00Z'); // already 14 September in Sofia
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  const HOURS_6 = 6 * 3600000;
  const pass = (next_page: number) => ({ day: '2026-09-12', delay: 1, next_page });
  function start(
    payload?: object,
    env: Partial<Env> = { REGISTRY_API_BASE_URL: 'https://published.test' },
  ) {
    const sleep = vi.fn(async () => {});
    const wf = new RegistryWorkflow({} as ExecutionContext, { DB: {}, ...env } as Env);
    const result = wf.run(
      { instanceId: 'run', payload, timestamp: new Date() } as never,
      { do: async (_name: string, fn: () => unknown) => fn(), sleep } as never,
    );
    return { result, sleep };
  }
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('neither takes the lease nor reads anything where the register API is not configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await start(PAYLOAD, {}).result).toMatchObject({ skipped: 'not-configured', read: 0 });
    expect(reg.acquireRegistryLease).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('registry_not_configured'));
  });

  it('steps aside while another run holds the lease and leaves that lease alone', async () => {
    reg.acquireRegistryLease.mockResolvedValue(false);
    expect(await start(PAYLOAD).result).toMatchObject({ skipped: 'lease-held', read: 0 });
    expect(reg.prepareEntryBaseline).not.toHaveBeenCalled();
    expect(reg.releaseRegistryLease).not.toHaveBeenCalled();
  });

  it('writes nothing once the lease is lost before its first step', async () => {
    reg.renewRegistryLease.mockResolvedValue(false);
    const run = start(PAYLOAD).result;
    await expect(run).rejects.toThrow('registry lease lost before');
    await expect(run).rejects.toBeInstanceOf(NonRetryableError);
    expect(reg.prepareEntryBaseline).not.toHaveBeenCalled();
    expect(reg.releaseRegistryLease).toHaveBeenCalledWith({}, 'run');
  });

  it('runs a cron start without a payload on the Sofia day, pacing portal pages and bounding deeds by default', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    reg.nextEntryPass
      .mockResolvedValueOnce(pass(1))
      .mockResolvedValueOnce(pass(2))
      .mockResolvedValue(null);
    client.changes
      .mockResolvedValueOnce({ items: [], hasMore: true, total: 30 })
      .mockResolvedValueOnce({ items: [], hasMore: false, total: 30 });
    reg.recordEntryPage.mockResolvedValue(3);
    const { result, sleep } = start(undefined);
    // Two pages of one day: six changes, one day finished.
    expect(await result).toMatchObject({ changeDays: 1, changed: 6, read: 1, roles: 2 });
    expect(reg.prepareEntryBaseline).toHaveBeenCalledWith({}, '2026-09-14', 'run', at(0));
    expect(client.changes.mock.calls).toEqual([
      ['2026-09-12', 1],
      ['2026-09-12', 2],
    ]);
    // Only the second portal read waits, for the default half minute.
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(expect.any(String), 30_000);
    expect(reg.queueNewWinners).toHaveBeenCalledWith({}, at(0), 2_500);
    expect(reg.nextQueued).toHaveBeenCalledWith({}, 25);
  });

  it('defers the portal for as long as it asks, or six hours when it names no wait', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    reg.nextEntryPass.mockResolvedValue(pass(1));
    client.changes.mockRejectedValueOnce(new RegistryError('slow down', 429, 60_000));
    await start(PAYLOAD).result;
    expect(reg.deferPortal).toHaveBeenLastCalledWith({}, at(60_000));
    client.changes.mockRejectedValueOnce(new RegistryError('maintenance', 503));
    await start(PAYLOAD).result;
    expect(reg.deferPortal).toHaveBeenLastCalledWith({}, at(HOURS_6));
    expect(reg.recordEntryPage).not.toHaveBeenCalled();
  });

  it('defers the portal when a page cannot be recorded, and still reads the queue', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    reg.nextEntryPass.mockResolvedValue(pass(2));
    client.changes.mockResolvedValue({ items: [], hasMore: true, total: 30 });
    reg.recordEntryPage.mockRejectedValue(new Error('portal repeated a page'));
    expect(await start(PAYLOAD).result).toMatchObject({ changed: 0, changeDays: 0, read: 1 });
    expect(reg.deferPortal).toHaveBeenCalledOnce();
    expect(reg.deferPortal).toHaveBeenCalledWith({}, at(HOURS_6));
    expect(client.changes).toHaveBeenCalledOnce();
  });

  it('ends the run when the lease is lost before a page is recorded, with no deferral or reads', async () => {
    reg.nextEntryPass.mockResolvedValue(pass(1));
    client.changes.mockImplementation(async () => {
      // Lost once is lost for good, even if a later renewal would pass.
      reg.renewRegistryLease.mockResolvedValueOnce(false);
      return { items: [], hasMore: false, total: 0 };
    });
    await expect(start(PAYLOAD).result).rejects.toThrow('lease lost');
    expect(reg.recordEntryPage).not.toHaveBeenCalled();
    expect(reg.deferPortal).not.toHaveBeenCalled();
    expect(client.deed).not.toHaveBeenCalled();
    expect(reg.releaseRegistryLease).toHaveBeenCalled();
  });

  it('reads full batches until the run’s bound and counts absent partidas', async () => {
    const full = Array.from({ length: 25 }, (_, i) => String(100000000 + i));
    reg.nextQueued.mockReset().mockResolvedValueOnce(full).mockResolvedValue(['200000000']);
    client.deed.mockResolvedValueOnce({ status: 'absent' });
    expect(await start({ ...PAYLOAD, maxDeeds: 26 }).result).toMatchObject({
      read: 26,
      absent: 1,
      roles: 52,
    });
    expect(reg.nextQueued.mock.calls.map((call) => call[1])).toEqual([25, 1]);
    expect(reg.queueNewWinners).toHaveBeenCalledWith({}, expect.any(String), 26);
  });

  it('waits the pace between two reads', async () => {
    vi.useFakeTimers();
    reg.nextQueued
      .mockReset()
      .mockResolvedValueOnce(['111111111', '222222222'])
      .mockResolvedValue([]);
    const { result } = start({ ...PAYLOAD, paceMs: 1_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(client.deed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ read: 2 });
    expect(client.deed).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed partida for the longer wait and pauses the XML service on 503', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    reg.nextQueued
      .mockReset()
      .mockResolvedValueOnce(['111111111', '222222222', '333333333'])
      .mockResolvedValue([]);
    client.deed
      .mockRejectedValueOnce(new RegistryError('upstream error', 500, 12 * 3600000))
      .mockRejectedValueOnce(new RegistryError('unavailable', 503));
    await start(PAYLOAD).result;
    expect(reg.deferDeed.mock.calls).toEqual([
      [{}, '111111111', at(12 * 3600000)],
      [{}, '222222222', at(HOURS_6)],
    ]);
    // A 503 without Retry-After pauses the service for three minutes and ends the batch.
    expect(reg.deferXml).toHaveBeenCalledOnce();
    expect(reg.deferXml).toHaveBeenCalledWith({}, at(180_000));
    expect(client.deed).toHaveBeenCalledTimes(2);
    expect(reg.storeDeed).not.toHaveBeenCalled();
  });

  it('leaves a failed partida alone once the lease is lost during its read', async () => {
    client.deed.mockImplementation(async () => {
      reg.renewRegistryLease.mockResolvedValue(false);
      throw new Error('timeout');
    });
    await expect(start(PAYLOAD).result).rejects.toThrow('lease lost');
    expect(reg.deferDeed).not.toHaveBeenCalled();
    expect(reg.releaseRegistryLease).toHaveBeenCalled();
  });

  it('keeps building the baseline while its scope is incomplete', async () => {
    reg.prepareEntryBaseline.mockResolvedValue('building');
    reg.completeEntryBaseline.mockResolvedValue(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await start(PAYLOAD).result).toMatchObject({ read: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"registry_baseline_building"'));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('"registry_baseline_complete"'));
  });
});
