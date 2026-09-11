import { afterEach, describe, expect, it, vi } from 'vitest';

// The register Workflow's control flow — not configured, lease held, following the changes feed, the
// backfill in batches, the gap fallback, a lost lease — with the D1 side and the API client mocked; the D1
// side itself is covered against a real SQLite in registry.test.ts, the client in @sigma/ingest.
vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    ctx: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock('cloudflare:workflows', () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}));
vi.mock('../../../scripts/refresh-slice.sql', () => ({ default: '' }));
vi.mock('../../../scripts/work-staging-schema.sql', () => ({ default: '' }));

const { client, reg } = vi.hoisted(() => ({
  client: { changedUics: vi.fn(), deed: vi.fn() },
  reg: {
    acquireRegistryLease: vi.fn(),
    renewRegistryLease: vi.fn(),
    releaseRegistryLease: vi.fn(),
    registryChangesThrough: vi.fn(),
    setRegistryChangesThrough: vi.fn(),
    queueChanged: vi.fn(),
    queueAllRead: vi.fn(),
    queueNewWinners: vi.fn(),
    nextQueued: vi.fn(),
    storeDeed: vi.fn(),
  },
}));
vi.mock('@sigma/ingest', () => ({ registryClient: () => client }));
vi.mock('./registry', () => reg);

import worker, { RegistryWorkflow, type Env } from './index';

const DB = {} as D1Database;
function run(env: Partial<Env>, payload: Record<string, unknown> = {}) {
  const steps: string[] = [];
  const step = { do: async (name: string, fn: () => Promise<unknown>) => (steps.push(name), fn()) };
  const wf = new RegistryWorkflow({} as ExecutionContext, { DB, ...env } as Env);
  const out = wf.run(
    {
      payload: { today: '2026-09-11', paceMs: 0, ...payload },
      timestamp: new Date(),
      instanceId: 'i1',
    },
    step as never,
  );
  return { out, steps };
}
const CONFIGURED = { REGISTRY_API_BASE_URL: 'http://registry.test' };

function happyDefaults() {
  reg.acquireRegistryLease.mockResolvedValue(true);
  reg.renewRegistryLease.mockResolvedValue(true);
  reg.registryChangesThrough.mockResolvedValue('2026-09-09');
  client.changedUics.mockResolvedValue({ uics: ['111111111'], complete: true });
  reg.queueChanged.mockResolvedValue(1);
  reg.queueNewWinners.mockResolvedValue(1);
  reg.nextQueued.mockResolvedValueOnce(['111111111', '222222222']).mockResolvedValue([]);
  client.deed
    .mockResolvedValueOnce({ status: 'ok', deed: {} })
    .mockResolvedValueOnce({ status: 'absent' });
  reg.storeDeed
    .mockResolvedValueOnce({ roles: 3, persons: 2 })
    .mockResolvedValueOnce({ roles: 0, persons: 0 });
}

afterEach(() => {
  for (const f of [...Object.values(reg), ...Object.values(client)]) f.mockReset();
});

describe('RegistryWorkflow', () => {
  it('does nothing where the API is not configured', async () => {
    const { out, steps } = run({});
    expect(await out).toMatchObject({ skipped: 'not-configured', read: 0 });
    expect(steps).toEqual([]);
  });

  it('steps aside while another run holds the lease, and releases nothing it does not hold', async () => {
    reg.acquireRegistryLease.mockResolvedValue(false);
    const { out, steps } = run(CONFIGURED);
    expect(await out).toMatchObject({ skipped: 'lease-held' });
    expect(steps).toEqual(['acquire-registry-lease']);
    expect(reg.releaseRegistryLease).not.toHaveBeenCalled();
  });

  it('follows the changes to yesterday, queues the new winners, reads the queue, and releases the lease', async () => {
    happyDefaults();
    const { out, steps } = run(CONFIGURED);
    expect(await out).toEqual({
      changeDays: 1,
      changed: 1,
      queuedNew: 1,
      read: 2,
      absent: 1,
      roles: 3,
    });
    expect(client.changedUics).toHaveBeenCalledWith('2026-09-10');
    expect(reg.setRegistryChangesThrough).toHaveBeenCalledWith(DB, '2026-09-10');
    expect(client.deed.mock.calls.map((c) => c[0])).toEqual(['111111111', '222222222']);
    expect(steps).toEqual([
      'acquire-registry-lease',
      'changes-through',
      'changes:2026-09-10',
      'queue-new-winners',
      'deeds:0',
      'release-registry-lease',
    ]);
  });

  it('starts from yesterday on its first run, and keeps reading while batches come back full', async () => {
    happyDefaults();
    reg.registryChangesThrough.mockResolvedValue(null);
    reg.nextQueued.mockReset();
    const full = Array.from({ length: 25 }, (_, i) => String(100000000 + i));
    reg.nextQueued.mockResolvedValueOnce(full).mockResolvedValueOnce(['999999999']);
    client.deed.mockReset();
    client.deed.mockResolvedValue({ status: 'ok', deed: {} });
    reg.storeDeed.mockReset();
    reg.storeDeed.mockResolvedValue({ roles: 1, persons: 1 });
    const { out, steps } = run(CONFIGURED);
    expect(await out).toMatchObject({ changeDays: 1, read: 26 });
    expect(steps).toContain('deeds:1');
  });

  it('re-reads every partida instead of following a feed left too far behind', async () => {
    happyDefaults();
    reg.registryChangesThrough.mockResolvedValue('2026-08-01');
    reg.queueAllRead.mockResolvedValue(40);
    const { out, steps } = run(CONFIGURED);
    await out;
    expect(steps).toContain('requeue-all');
    expect(client.changedUics).not.toHaveBeenCalled();
    expect(reg.setRegistryChangesThrough).toHaveBeenCalledWith(DB, '2026-09-10');
  });

  it('re-reads every partida after a day longer than the feed is followed for — a reload of the API', async () => {
    happyDefaults();
    client.changedUics.mockResolvedValue({ uics: ['111111111'], complete: false });
    reg.queueAllRead.mockResolvedValue(40);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { out } = run(CONFIGURED);
    expect(await out).toMatchObject({ changeDays: 1, changed: 40 });
    expect(reg.queueChanged).not.toHaveBeenCalled();
    expect(reg.setRegistryChangesThrough).toHaveBeenCalledWith(DB, '2026-09-10');
    expect(warn.mock.calls.some(([m]) => String(m).includes('registry_changes_overflow'))).toBe(
      true,
    );
    warn.mockRestore();
  });

  it('stops for good once the lease is lost, and still releases what it may hold', async () => {
    happyDefaults();
    reg.renewRegistryLease.mockResolvedValue(false);
    const { out } = run(CONFIGURED);
    await expect(out).rejects.toThrow(/lease lost before changes:2026-09-10/);
    expect(reg.releaseRegistryLease).toHaveBeenCalledWith(DB, 'i1');
  });

  it('stops reading at the run’s bound', async () => {
    happyDefaults();
    const { out } = run(CONFIGURED, { maxDeeds: 1 });
    await out;
    expect(reg.nextQueued).toHaveBeenCalledWith(DB, 1);
  });
});

describe('scheduled', () => {
  it('starts the register layer beside the refresh only where it is configured', async () => {
    const create = vi.fn(async () => ({ id: 'x' }));
    const registry = vi.fn(async () => ({ id: 'y' }));
    const env = { DB, REFRESH: { create }, REGISTRY: { create: registry } } as unknown as Env;
    await worker.scheduled({} as ScheduledController, env);
    expect(registry).not.toHaveBeenCalled();
    await worker.scheduled({} as ScheduledController, { ...env, ...CONFIGURED });
    expect(registry).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
