import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeD1 } from '@sigma/test-support';

// index.test.ts covers the FX/derive path end-to-end against a real SQLite (#158). This file isolates
// the RefreshWorkflow.run()/scheduled() *control flow* — plan → capped warning → zero-ingest
// short-circuit → derive loop → integrity gate → finally-drop — by mocking the platform base class,
// the Workflow error type, the build-time `.sql` imports, the ingest helpers, the eop bucket walk, and
// the served integrity gate, so each orchestration branch is asserted without any real D1 or network.
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
vi.mock('../../../scripts/refresh-slice.sql', () => ({ default: 'REFRESH_SLICE_SQL' }));
vi.mock('../../../scripts/work-staging-schema.sql', () => ({ default: 'WORK_STAGING_SCHEMA_SQL' }));

type GateLog = { info: (e: object) => void; warn: (e: object) => void; error: (e: object) => void };

// Hoisted so the vi.mock factories (themselves hoisted above the imports) can close over them.
const { ingest, eop, integrity } = vi.hoisted(() => ({
  ingest: {
    createTransientStaging: vi.fn(async () => {}),
    dropTransientStaging: vi.fn(async () => {}),
    refreshDerivedContractCount: vi.fn(async () => 42),
    refreshSliceStatementGroups: vi.fn(() => [{ name: 'g1', statements: ['a', 'b'] }]),
    runRefreshSliceStatementGroup: vi.fn(async () => {}),
    loadFxRates: vi.fn(async () => ({
      inserted: 0,
      fetched: 0,
      skipped: 0,
      warnings: [] as string[],
      uncovered: [] as string[],
    })),
  },
  eop: {
    computeWorkerCatchupPlan: vi.fn(),
    ingestBucketWindow: vi.fn(),
  },
  integrity: {
    runServedIntegrityGate: vi.fn(async (_db: unknown, _log: GateLog) => {}),
  },
}));
vi.mock('@sigma/ingest', () => ingest);
vi.mock('./eop', () => eop);
vi.mock('./integrity', () => integrity);

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

// Every ingest/refresh writer is mocked in this file, so the binding must never be touched. A
// route-less double throws on any query instead of quietly answering one. One shared instance, so
// the assertions below can name the exact handle the workflow was expected to pass down.
const DB = fakeD1([]).db;

function makeWorkflow() {
  return new RefreshWorkflow({} as never, { DB, REFRESH: {} as Workflow });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('RefreshWorkflow.run — control flow', () => {
  it('runs the full pipeline: stage, ingest, load FX, derive slice groups, gate, count, and drop', async () => {
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
    expect(ingest.createTransientStaging).toHaveBeenCalledWith(DB, 'WORK_STAGING_SCHEMA_SQL');
    expect(ingest.loadFxRates).toHaveBeenCalledOnce(); // FX loaded before derive (#158)
    expect(ingest.runRefreshSliceStatementGroup).toHaveBeenCalledTimes(1);
    expect(ingest.refreshDerivedContractCount).toHaveBeenCalledOnce();
    expect(integrity.runServedIntegrityGate).toHaveBeenCalledOnce();
    expect(names).toContain('load-fx');
    expect(names).toContain('derive-slice:g1');
    expect(names).toContain('integrity-gate');
    expect(names).toContain('drop-transient-staging'); // finally always drops
  });

  it('warns when FX loading reports uncovered currency pairs', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseContracts: 1 })]);
    ingest.loadFxRates.mockResolvedValueOnce({
      inserted: 1,
      fetched: 2,
      skipped: 0,
      warnings: ['frankfurter slow'],
      uncovered: ['2026-06-05:USD'],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wf = makeWorkflow();

    await wf.run({ payload: {} } as never, fakeStep([]) as never);

    expect(warn.mock.calls.some((c) => String(c[0]).includes('etl_fx_uncovered'))).toBe(true);
  });

  it('wires the integrity-gate logger to structured console info/warn/error', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseContracts: 1 })]);
    // Drive all three logger callbacks the run() passes into the gate, so each console wrapper runs.
    integrity.runServedIntegrityGate.mockImplementationOnce(async (_db: unknown, log: GateLog) => {
      log.info({ event: 'gate_info' });
      log.warn({ event: 'gate_warn' });
      log.error({ event: 'gate_error' });
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wf = makeWorkflow();

    await wf.run({ payload: {} } as never, fakeStep([]) as never);

    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('"event":"gate_info"'))).toBe(true);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('"event":"gate_warn"'))).toBe(true);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('"event":"gate_error"'))).toBe(true);
  });

  it('defaults the payload to an empty object when the event carries none', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseTenders: 1 })]);
    const wf = makeWorkflow();

    const result = await wf.run({} as never, fakeStep([]) as never);
    expect(result.staged).toBe(1);
    expect(eop.computeWorkerCatchupPlan).toHaveBeenCalledWith(DB, {
      today: undefined,
      lookbackDays: undefined,
      maxWindowDays: undefined,
    });
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
    expect(ingest.loadFxRates).not.toHaveBeenCalled(); // no FX/derive on empty ingest
    expect(ingest.runRefreshSliceStatementGroup).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('etl_zero_ingest'))).toBe(true);
    expect(names).toContain('drop-transient-staging'); // finally still runs
  });

  it('fails the run non-retryably when the served integrity gate throws, still dropping staging', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseContracts: 2 })]);
    integrity.runServedIntegrityGate.mockRejectedValueOnce(new Error('reconciliation drift'));
    const wf = makeWorkflow();
    const names: string[] = [];

    await expect(wf.run({ payload: {} } as never, fakeStep(names) as never)).rejects.toThrow(
      'reconciliation drift',
    );
    expect(names).toContain('integrity-gate');
    expect(names).toContain('drop-transient-staging'); // finally runs on the gate-failure path
    expect(ingest.dropTransientStaging).toHaveBeenCalled();
  });

  it('stringifies a non-Error gate rejection into the NonRetryableError message', async () => {
    // The gate catch wraps `err instanceof Error ? err.message : String(err)`; a thrown non-Error
    // exercises the String(err) side that an Error rejection cannot.
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseContracts: 2 })]);
    integrity.runServedIntegrityGate.mockRejectedValueOnce('raw string fault');
    const wf = makeWorkflow();

    await expect(wf.run({ payload: {} } as never, fakeStep([]) as never)).rejects.toThrow(
      'raw string fault',
    );
    expect(ingest.dropTransientStaging).toHaveBeenCalled(); // finally still drops
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
    const env = { DB: fakeD1([]).db, REFRESH: { create } as unknown as Workflow };

    await worker.scheduled?.({} as never, env);

    expect(create).toHaveBeenCalledOnce();
    expect(log.mock.calls.some((c) => String(c[0]).includes('"id":"wf-123"'))).toBe(true);
  });
});
