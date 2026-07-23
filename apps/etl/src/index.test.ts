import { afterEach, describe, expect, it, vi } from 'vitest';

// index.ts is the Cloudflare Workflow entrypoint. Isolate its orchestration by mocking the platform
// base class, the build-time `.sql` string imports, the ingest helpers, and the eop bucket walk — so
// these tests assert the run()/scheduled() control flow (staging lifecycle, capped/zero-ingest
// branches, derive loop, finally-drop) without any real D1, network, or Workflow runtime.
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
vi.mock('../../../scripts/refresh-slice.sql', () => ({ default: 'REFRESH_SLICE_SQL' }));
vi.mock('../../../scripts/work-staging-schema.sql', () => ({ default: 'WORK_STAGING_SCHEMA_SQL' }));

// Hoisted so the vi.mock factories (themselves hoisted above the imports) can close over them.
const { ingest, eop } = vi.hoisted(() => ({
  ingest: {
    createTransientStaging: vi.fn(async () => {}),
    dropTransientStaging: vi.fn(async () => {}),
    refreshDerivedContractCount: vi.fn(async () => 42),
    refreshSliceStatementGroups: vi.fn(() => [{ name: 'g1', statements: ['a', 'b'] }]),
    runRefreshSliceStatementGroup: vi.fn(async () => {}),
  },
  eop: {
    computeWorkerCatchupPlan: vi.fn(),
    ingestBucketWindow: vi.fn(),
  },
}));
vi.mock('@sigma/ingest', () => ingest);
vi.mock('./eop', () => eop);

import worker, { RefreshWorkflow } from './index';

const PLAN = {
  maxLoadedDate: '2026-06-01',
  from: '2026-05-29',
  to: '2026-06-07',
  gapDays: 10,
  capped: false,
  originalFrom: '2026-05-29',
  originalGapDays: 10,
};

const dayResult = (over: Partial<Record<string, number>> = {}) => ({
  day: '2026-06-07',
  found: true,
  baseContracts: 0,
  baseTenders: 0,
  baseAmendments: 0,
  ocdsContracts: 0,
  ocdsAmendments: 0,
  parties: 0,
  lots: 0,
  ...over,
});

// A step runner that simply executes each step body inline and records the step names.
function fakeStep(names: string[]) {
  return {
    do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      names.push(name);
      return fn();
    },
  };
}

function makeWorkflow() {
  const env = { DB: {} as D1Database, REFRESH: {} as Workflow };
  return new RefreshWorkflow({} as never, env);
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('RefreshWorkflow.run', () => {
  it('runs the full pipeline: stage, ingest, derive slice groups, count, and drop', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([
      // All seven staged-row counts are non-zero (distinct values) so `staged` guards every term of
      // the sum — including baseAmendments/ocdsAmendments, which no other case exercises.
      dayResult({
        baseContracts: 3,
        baseTenders: 6,
        baseAmendments: 5,
        ocdsContracts: 2,
        ocdsAmendments: 7,
        parties: 1,
        lots: 4,
      }),
    ]);
    const wf = makeWorkflow();
    const names: string[] = [];

    const result = await wf.run(
      { payload: { today: '2026-06-07' } } as never,
      fakeStep(names) as never,
    );

    expect(result).toMatchObject({ from: '2026-05-29', days: 1, staged: 28, derived: 42 });
    expect(ingest.createTransientStaging).toHaveBeenCalledWith({}, 'WORK_STAGING_SCHEMA_SQL');
    expect(ingest.runRefreshSliceStatementGroup).toHaveBeenCalledTimes(1);
    expect(ingest.refreshDerivedContractCount).toHaveBeenCalledOnce();
    expect(names).toContain('derive-slice:g1');
    expect(names).toContain('drop-transient-staging'); // finally always drops
  });

  it('defaults the payload to an empty object when the event carries none', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseTenders: 1 })]);
    const wf = makeWorkflow();

    const result = await wf.run({} as never, fakeStep([]) as never);
    expect(result.staged).toBe(1);
    expect(eop.computeWorkerCatchupPlan).toHaveBeenCalledWith(
      {},
      { today: undefined, lookbackDays: undefined, maxWindowDays: undefined },
    );
  });

  it('logs a capped warning when the plan window was truncated', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue({
      ...PLAN,
      capped: true,
      from: '2026-05-18',
      gapDays: 21,
      originalGapDays: 40,
    });
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseContracts: 5 })]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wf = makeWorkflow();

    await wf.run({ payload: {} } as never, fakeStep([]) as never);

    const capped = warn.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('etl_window_capped'));
    expect(capped).toBeDefined();
    expect(capped).toContain('"originalGapDays":40');
  });

  it('short-circuits with a zero-ingest warning and still drops staging when nothing staged', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult()]); // all counts 0
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wf = makeWorkflow();
    const names: string[] = [];

    const result = await wf.run({ payload: {} } as never, fakeStep(names) as never);

    expect(result).toMatchObject({ days: 1, staged: 0, derived: 0 });
    expect(ingest.runRefreshSliceStatementGroup).not.toHaveBeenCalled(); // no derive on empty ingest
    expect(warn.mock.calls.some((c) => String(c[0]).includes('etl_zero_ingest'))).toBe(true);
    expect(names).toContain('drop-transient-staging'); // finally still runs
  });

  it('drops staging even when ingestion throws', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockRejectedValue(new Error('bucket down'));
    const wf = makeWorkflow();
    const names: string[] = [];

    await expect(wf.run({ payload: {} } as never, fakeStep(names) as never)).rejects.toThrow(
      'bucket down',
    );
    expect(names).toContain('drop-transient-staging'); // finally runs on the error path
    expect(ingest.dropTransientStaging).toHaveBeenCalled();
  });
});

describe('scheduled handler', () => {
  it('kicks one durable refresh run and logs its id', async () => {
    const create = vi.fn(async () => ({ id: 'wf-123' }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = { DB: {} as D1Database, REFRESH: { create } as unknown as Workflow };

    await worker.scheduled?.({} as never, env);

    expect(create).toHaveBeenCalledOnce();
    expect(log.mock.calls.some((c) => String(c[0]).includes('"id":"wf-123"'))).toBe(true);
  });
});
