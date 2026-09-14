import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
  DurableObject: class {},
}));
vi.mock('cloudflare:workflows', () => ({ NonRetryableError: class extends Error {} }));
vi.mock('../../../scripts/refresh-slice.sql', () => ({ default: '' }));
vi.mock('../../../scripts/work-staging-schema.sql', () => ({ default: '' }));
const { client, reg } = vi.hoisted(() => ({
  client: { changes: vi.fn(), deed: vi.fn() },
  reg: {
    acquireRegistryLease: vi.fn(),
    renewRegistryLease: vi.fn(),
    releaseRegistryLease: vi.fn(),
    seedEntryPasses: vi.fn(),
    nextEntryPass: vi.fn(),
    recordEntryPage: vi.fn(),
    deferPortal: vi.fn(),
    deferDeed: vi.fn(),
    deferXml: vi.fn(),
    queueNewWinners: vi.fn(),
    nextQueued: vi.fn(),
    storeDeed: vi.fn(),
  },
}));
vi.mock('@sigma/ingest', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  registryClient: () => client,
}));
vi.mock('./registry', () => reg);
import { RegistryError } from '@sigma/ingest';
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
  reg.renewRegistryLease.mockResolvedValue(true);
  reg.nextEntryPass.mockResolvedValue(null);
  reg.queueNewWinners.mockResolvedValue(1);
  reg.nextQueued.mockResolvedValueOnce(['111111111']).mockResolvedValue([]);
  client.deed.mockResolvedValue({ status: 'ok', deed: {} });
  reg.storeDeed.mockResolvedValue({ roles: 2, persons: 1 });
});
describe('published registry Workflow', () => {
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
  it('starts all cron jobs even when the procurement start fails', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'registry' });
    const startRun = vi.fn().mockResolvedValue({ runId: 'declarations' });
    await expect(
      worker.scheduled(
        {} as never,
        {
          REFRESH: {
            create: async () => {
              throw Error('failed');
            },
          },
          REGISTRY: { create },
          REGISTRY_API_BASE_URL: 'https://published.test',
          DECLARATIONS_ENABLED: 'true',
          DECLARATIONS: { getByName: () => ({ startRun }) },
        } as unknown as Env,
      ),
    ).rejects.toThrow('scheduled starts failed');
    expect(create).toHaveBeenCalledOnce();
    expect(startRun).toHaveBeenCalledOnce();
  });
});
