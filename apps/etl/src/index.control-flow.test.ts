import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeD1 } from '@sigma/test-support';
import type { PendingWindow, RefreshLease } from '@sigma/ingest';

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
    acquireRefreshLease: vi.fn(
      async (): Promise<RefreshLease> => ({
        acquired: true,
        holder: 'test-instance',
        expiresAt: '2026-06-07T00:30:00.000Z',
      }),
    ),
    releaseRefreshLease: vi.fn(async () => {}),
    pendingWindows: vi.fn(async (): Promise<PendingWindow[]> => []),
    recordPendingWindow: vi.fn(async () => {}),
    settlePendingWindows: vi.fn(
      async (
        _db: unknown,
        _covered: { from: string; to: string },
        _now?: Date,
        _eligible?: (w: PendingWindow) => boolean,
      ) => ({ settled: 0, remaining: [] as PendingWindow[] }),
    ),
    renewRefreshLease: vi.fn(
      async (): Promise<RefreshLease> => ({
        acquired: true,
        holder: 'test-instance',
        expiresAt: '2026-06-07T00:30:00.000Z',
      }),
    ),
    createTransientStaging: vi.fn(async () => {}),
    dropTransientStaging: vi.fn(async () => {}),
    refreshDerivedContractCount: vi.fn(async () => 42),
    pendingTouchedRows: vi.fn(async () => ({ contracts: 0, bidders: 0, authorities: 0, total: 0 })),
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
    // real arithmetic: the residual window is computed from it
    addDays: (day: string, days: number) => {
      const d = new Date(`${day}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    },
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
      replay: [],
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

    expect(result).toMatchObject({ days: 1, staged: 0, derived: 0, pendingTouched: 0 });
    expect(ingest.loadFxRates).not.toHaveBeenCalled(); // no FX/derive on empty ingest
    expect(ingest.runRefreshSliceStatementGroup).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('etl_zero_ingest'))).toBe(true);
    expect(names).toContain('pending-touched'); // the short-circuit asks first
    expect(names).toContain('drop-transient-staging'); // finally still runs
  });

  it('derives on an empty window when an earlier aborted run left touched rows behind', async () => {
    // The touched sets survive an abort (refresh-slice.sql keeps them until its cleanup batch), so
    // "nothing staged" no longer means "nothing to do": the previous run's rollups are still owed.
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult()]); // all counts 0
    ingest.pendingTouchedRows.mockResolvedValueOnce({
      contracts: 3,
      bidders: 2,
      authorities: 1,
      total: 6,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wf = makeWorkflow();
    const names: string[] = [];

    const result = await wf.run({ payload: {} } as never, fakeStep(names) as never);

    expect(result).toMatchObject({ days: 1, staged: 0, derived: 42, pendingTouched: 6 });
    expect(ingest.loadFxRates).toHaveBeenCalledTimes(1);
    expect(ingest.runRefreshSliceStatementGroup).toHaveBeenCalledTimes(1); // g1 ran
    expect(integrity.runServedIntegrityGate).toHaveBeenCalledTimes(1);
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned.some((l) => l.includes('etl_zero_ingest_pending_touched'))).toBe(true);
    expect(warned.some((l) => l.includes('"etl_zero_ingest"'))).toBe(false); // not the short-circuit
    expect(names.indexOf('pending-touched')).toBeLessThan(names.indexOf('load-fx'));
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

describe('RefreshWorkflow.run — refresh lease', () => {
  it('takes the lease first and releases it last, after the staging drop', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseContracts: 1 })]);
    const wf = makeWorkflow();
    const names: string[] = [];

    await wf.run({ payload: {}, instanceId: 'wf-42' } as never, fakeStep(names) as never);

    expect(names[0]).toBe('acquire-refresh-lease');
    expect(names.at(-1)).toBe('release-refresh-lease');
    expect(names.indexOf('drop-transient-staging')).toBeLessThan(
      names.indexOf('release-refresh-lease'),
    );
    expect(ingest.acquireRefreshLease).toHaveBeenCalledWith(DB, 'wf-42', expect.any(Date));
    expect(ingest.releaseRefreshLease).toHaveBeenCalledWith(DB, 'wf-42');
  });

  it('steps aside — touching nothing — when another live instance holds the lease', async () => {
    ingest.acquireRefreshLease.mockResolvedValueOnce({
      acquired: false,
      holder: 'wf-41',
      expiresAt: '2026-06-07T00:20:00.000Z',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wf = makeWorkflow();
    const names: string[] = [];

    const result = await wf.run(
      { payload: { today: '2026-06-07' }, instanceId: 'wf-42' } as never,
      fakeStep(names) as never,
    );

    expect(result).toMatchObject({
      skipped: 'lease-held',
      leaseHolder: 'wf-41',
      from: '2026-06-07',
      to: '2026-06-07',
      staged: 0,
      derived: 0,
      pendingTouched: 0,
    });
    expect(names).toEqual(['acquire-refresh-lease']); // nothing else ran — not even the staging drop
    expect(ingest.dropTransientStaging).not.toHaveBeenCalled();
    expect(eop.computeWorkerCatchupPlan).not.toHaveBeenCalled();
    expect(ingest.releaseRefreshLease).not.toHaveBeenCalled(); // it is not ours to release
    const held = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('etl_refresh_lease_held'));
    expect(held).toBeDefined();
    expect(JSON.parse(held!)).toMatchObject({
      holder: 'wf-41',
      expiresAt: '2026-06-07T00:20:00.000Z',
    });
  });

  it('releases the lease even when the run fails', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockRejectedValueOnce(new Error('storage down'));
    const wf = makeWorkflow();
    const names: string[] = [];

    await expect(
      wf.run({ payload: {}, instanceId: 'wf-43' } as never, fakeStep(names) as never),
    ).rejects.toThrow(/storage down/);

    expect(names.at(-1)).toBe('release-refresh-lease');
    expect(ingest.releaseRefreshLease).toHaveBeenCalledWith(DB, 'wf-43');
  });
});

describe('RefreshWorkflow.run — lease fence', () => {
  it('renews the lease before every writing step and once more before dropping staging', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseContracts: 1 })]);
    const wf = makeWorkflow();
    const names: string[] = [];

    await wf.run({ payload: {}, instanceId: 'wf-50' } as never, fakeStep(names) as never);

    // drop-stale, record-window, create, ingest, load-fx, derive g1, count, gate, clear-window = 9
    // fenced steps, + the finally's own check before dropping staging
    expect(ingest.renewRefreshLease).toHaveBeenCalledTimes(10);
    expect(ingest.renewRefreshLease).toHaveBeenCalledWith(DB, 'wf-50', expect.any(Date));
    // plan-catchup and pending-touched only read: not fenced
    expect(names).toEqual(
      expect.arrayContaining([
        'plan-catchup',
        'pending-touched',
        'derive-slice:g1',
        'integrity-gate',
      ]),
    );
  });

  it('stops before the next write when the lease is lost, leaves staging to the new holder, still releases', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseContracts: 1 })]);
    // drop-stale, create, ingest renew fine; the renew before load-fx finds a new holder; so does the finally's.
    // One-shot answers, so nothing leaks into the next test: the four renewals before load-fx
    // (drop-stale, record-window, create, ingest) succeed; load-fx's fence and the finally's check
    // find the new holder.
    const ours = { acquired: true, holder: 'wf-51', expiresAt: '2026-06-07T00:30:00.000Z' };
    const theirs = { acquired: false, holder: 'wf-52', expiresAt: '2026-06-07T00:45:00.000Z' };
    ingest.renewRefreshLease
      .mockResolvedValueOnce(ours)
      .mockResolvedValueOnce(ours)
      .mockResolvedValueOnce(ours)
      .mockResolvedValueOnce(ours)
      .mockResolvedValueOnce(theirs)
      .mockResolvedValueOnce(theirs);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wf = makeWorkflow();
    const names: string[] = [];

    await expect(
      wf.run({ payload: {}, instanceId: 'wf-51' } as never, fakeStep(names) as never),
    ).rejects.toThrow(/refresh lease lost before load-fx: now held by wf-52/);

    expect(ingest.loadFxRates).not.toHaveBeenCalled(); // the fence fired before the body
    expect(ingest.runRefreshSliceStatementGroup).not.toHaveBeenCalled();
    // the staging tables belong to wf-52 now: only the drop-stale call at the start, none in finally
    expect(ingest.dropTransientStaging).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(
      expect.arrayContaining([expect.stringContaining('etl_refresh_staging_left_to_new_holder')]),
    );
    expect(names.at(-1)).toBe('release-refresh-lease'); // holder-qualified: harmless for wf-52's row
    expect(ingest.releaseRefreshLease).toHaveBeenCalledWith(DB, 'wf-51');
  });

  it('releases the lease even when dropping the staging tables throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseContracts: 1 })]);
    ingest.dropTransientStaging
      .mockResolvedValueOnce(undefined) // drop-stale at the start
      .mockRejectedValueOnce(new Error('D1 hiccup on drop')); // the finally's drop
    const wf = makeWorkflow();
    const names: string[] = [];

    await expect(
      wf.run({ payload: {}, instanceId: 'wf-53' } as never, fakeStep(names) as never),
    ).rejects.toThrow(/D1 hiccup on drop/);

    expect(names.at(-1)).toBe('release-refresh-lease');
    expect(ingest.releaseRefreshLease).toHaveBeenCalledWith(DB, 'wf-53');
  });
});

describe('RefreshWorkflow.run — failures inside finally', () => {
  it('reports the gate failure, not the staging-drop hiccup that followed it', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseContracts: 1 })]);
    integrity.runServedIntegrityGate.mockRejectedValueOnce(
      new Error(
        'integrity gate failed: 1 of 8 checks broke (cron refresh): rollup-reconciliation — x.',
      ),
    );
    ingest.dropTransientStaging
      .mockResolvedValueOnce(undefined) // drop-stale at the start
      .mockRejectedValueOnce(new Error('D1 hiccup on drop')); // the finally's drop
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wf = makeWorkflow();
    const names: string[] = [];

    await expect(
      wf.run({ payload: {}, instanceId: 'wf-60' } as never, fakeStep(names) as never),
    ).rejects.toThrow(/integrity gate failed: 1 of 8 checks broke/);

    const logged = error.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('etl_refresh_staging_drop_failed'))).toBe(true);
    expect(logged.some((l) => l.includes('"afterFailure":true'))).toBe(true);
    expect(names.at(-1)).toBe('release-refresh-lease');
    expect(ingest.releaseRefreshLease).toHaveBeenCalledWith(DB, 'wf-60');
  });
});

describe('RefreshWorkflow.run — window replay', () => {
  it('records its window before staging and clears it only after the gate passed', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseContracts: 1 })]);
    const wf = makeWorkflow();
    const names: string[] = [];

    await wf.run({ payload: {}, instanceId: 'wf-70' } as never, fakeStep(names) as never);

    expect(names.indexOf('pending-window')).toBeLessThan(names.indexOf('plan-catchup'));
    expect(names.indexOf('record-window')).toBeGreaterThan(names.indexOf('plan-catchup'));
    expect(names.indexOf('record-window')).toBeLessThan(names.indexOf('create-transient-staging'));
    expect(names.indexOf('settle-windows')).toBeGreaterThan(names.indexOf('integrity-gate'));
    expect(ingest.recordPendingWindow).toHaveBeenCalledWith(
      DB,
      'wf-70',
      PLAN.from,
      PLAN.to,
      expect.any(Date),
    );
    expect(ingest.settlePendingWindows).toHaveBeenCalledTimes(1);
    // the planner was told there was nothing to replay
    expect(eop.computeWorkerCatchupPlan).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ replay: [] }),
    );
  });

  it('hands an unfinished window to the planner and warns that it is replaying', async () => {
    ingest.pendingWindows.mockResolvedValueOnce([
      {
        from: '2026-05-20',
        to: '2026-05-31',
        holder: 'wf-dead',
        startedAt: '2026-05-31T00:00:05.000Z',
      },
    ]);
    eop.computeWorkerCatchupPlan.mockResolvedValue({
      ...PLAN,
      from: '2026-05-20',
      originalFrom: '2026-05-20',
      replayFrom: '2026-05-20',
    });
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseContracts: 1 })]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wf = makeWorkflow();
    const names: string[] = [];

    const result = await wf.run(
      { payload: {}, instanceId: 'wf-71' } as never,
      fakeStep(names) as never,
    );

    expect(eop.computeWorkerCatchupPlan).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ replay: [{ from: '2026-05-20', to: '2026-05-31' }] }),
    );
    expect(ingest.recordPendingWindow).toHaveBeenCalledWith(
      DB,
      'wf-71',
      '2026-05-20',
      PLAN.to,
      expect.any(Date),
    );
    expect(result.replayFrom).toBe('2026-05-20');
    const replay = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('etl_refresh_replay_window'));
    expect(replay).toBeDefined();
    expect(JSON.parse(replay!)).toMatchObject({
      unsettled: [{ holder: 'wf-dead' }],
      from: '2026-05-20',
    });
  });

  it('leaves the window recorded when the gate fails, so the next run replays it', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseContracts: 1 })]);
    integrity.runServedIntegrityGate.mockRejectedValueOnce(new Error('integrity gate failed: x'));
    const wf = makeWorkflow();
    const names: string[] = [];

    await expect(
      wf.run({ payload: {}, instanceId: 'wf-72' } as never, fakeStep(names) as never),
    ).rejects.toThrow(/integrity gate failed/);

    expect(ingest.recordPendingWindow).toHaveBeenCalledTimes(1);
    expect(ingest.settlePendingWindows).not.toHaveBeenCalled();
    expect(names).not.toContain('settle-windows');
  });

  it('clears the window on an empty ingest with nothing pending — it was fully covered', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult()]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wf = makeWorkflow();
    const names: string[] = [];

    await wf.run({ payload: {}, instanceId: 'wf-73' } as never, fakeStep(names) as never);

    expect(names).toContain('settle-windows-empty');
    expect(ingest.settlePendingWindows).toHaveBeenCalledTimes(1);
  });
});

describe('RefreshWorkflow.run — inherited windows are never certified by an empty ingest', () => {
  it('runs the derive and the gate on an empty ingest when an earlier window is unfinished', async () => {
    ingest.pendingWindows.mockResolvedValueOnce([
      {
        from: '2026-05-25',
        to: '2026-05-31',
        holder: 'wf-dead',
        startedAt: '2026-05-31T00:00:05.000Z',
      },
    ]);
    eop.computeWorkerCatchupPlan.mockResolvedValue({
      ...PLAN,
      from: '2026-05-25',
      originalFrom: '2026-05-25',
    });
    eop.ingestBucketWindow.mockResolvedValue([dayResult()]); // nothing staged today
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wf = makeWorkflow();
    const names: string[] = [];

    const result = await wf.run(
      { payload: {}, instanceId: 'wf-90' } as never,
      fakeStep(names) as never,
    );

    expect(result.staged).toBe(0);
    expect(names).not.toContain('settle-windows-empty'); // no short-circuit
    expect(ingest.runRefreshSliceStatementGroup).toHaveBeenCalledTimes(1); // the derive ran
    expect(integrity.runServedIntegrityGate).toHaveBeenCalledTimes(1); // and was verified
    expect(names.indexOf('settle-windows')).toBeGreaterThan(names.indexOf('integrity-gate'));
  });

  it('records only its own capped coverage and reports what stays uncovered after settling', async () => {
    ingest.pendingWindows.mockResolvedValueOnce([
      {
        from: '2026-04-01',
        to: '2026-04-10',
        holder: 'wf-dead',
        startedAt: '2026-04-10T00:00:05.000Z',
      },
    ]);
    eop.computeWorkerCatchupPlan.mockResolvedValue({
      ...PLAN,
      from: '2026-05-18', // capped: today − 20
      to: '2026-06-07',
      capped: true,
      originalFrom: '2026-04-01',
      replayFrom: '2026-04-01',
    });
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseContracts: 1 })]);
    ingest.settlePendingWindows.mockResolvedValueOnce({
      settled: 1,
      remaining: [
        {
          from: '2026-04-01',
          to: '2026-04-10',
          holder: 'wf-dead',
          startedAt: '2026-04-10T00:00:05.000Z',
        },
      ],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wf = makeWorkflow();
    const names: string[] = [];

    const result = await wf.run(
      { payload: {}, instanceId: 'wf-91' } as never,
      fakeStep(names) as never,
    );

    // the record is the CAPPED coverage, never the hull the plan was made from
    expect(ingest.recordPendingWindow).toHaveBeenCalledWith(
      DB,
      'wf-91',
      '2026-05-18',
      '2026-06-07',
      expect.any(Date),
    );
    expect(ingest.recordPendingWindow).toHaveBeenCalledTimes(1);
    expect(ingest.settlePendingWindows).toHaveBeenCalledWith(
      DB,
      { from: '2026-05-18', to: '2026-06-07' },
      expect.any(Date),
      expect.any(Function),
    );
    expect(result.uncoveredWindows).toBe(1);
    const uncovered = warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('etl_refresh_window_uncovered'));
    expect(JSON.parse(uncovered!)).toMatchObject({
      uncovered: [{ from: '2026-04-01', to: '2026-04-10' }],
    });
  });
});

describe('RefreshWorkflow.run — inherited promises need evidence the source answered', () => {
  const inherited = {
    from: '2026-05-25',
    to: '2026-05-31',
    holder: 'wf-dead',
    startedAt: '2026-05-31T00:00:05.000Z',
  };

  it('holds inherited promises back when no bucket was found, settling only its own', async () => {
    ingest.pendingWindows.mockResolvedValueOnce([inherited]);
    eop.computeWorkerCatchupPlan.mockResolvedValue({
      ...PLAN,
      from: '2026-05-25',
      originalFrom: '2026-05-25',
    });
    eop.ingestBucketWindow.mockResolvedValue([{ ...dayResult(), found: false }]); // nothing found // found: false, nothing staged
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wf = makeWorkflow();

    await wf.run({ payload: {}, instanceId: 'wf-110' } as never, fakeStep([]) as never);

    const eligible = ingest.settlePendingWindows.mock.calls[0]![3]!;
    expect(eligible({ ...inherited })).toBe(false);
    expect(eligible({ ...inherited, holder: 'wf-110' })).toBe(true); // its own promise
    expect(
      warn.mock.calls
        .map((c) => String(c[0]))
        .some((l) => l.includes('etl_refresh_replay_unverified')),
    ).toBe(true);
  });

  it('settles inherited promises once at least one bucket in the window was found', async () => {
    ingest.pendingWindows.mockResolvedValueOnce([inherited]);
    eop.computeWorkerCatchupPlan.mockResolvedValue({
      ...PLAN,
      from: '2026-05-25',
      originalFrom: '2026-05-25',
    });
    eop.ingestBucketWindow.mockResolvedValue([
      { ...dayResult(), found: false },
      { ...dayResult(), day: '2026-06-06', found: true }, // one bucket found: the source answers
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wf = makeWorkflow();

    await wf.run({ payload: {}, instanceId: 'wf-111' } as never, fakeStep([]) as never);

    const eligible = ingest.settlePendingWindows.mock.calls[0]![3]!;
    expect(eligible({ ...inherited })).toBe(true);
    expect(
      warn.mock.calls
        .map((c) => String(c[0]))
        .some((l) => l.includes('etl_refresh_replay_unverified')),
    ).toBe(false);
  });
});

describe('RefreshWorkflow.run — release failures never mask the run', () => {
  it('reports the gate failure when both the drop and the release fail after it', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseContracts: 1 })]);
    integrity.runServedIntegrityGate.mockRejectedValueOnce(
      new Error('integrity gate failed: the real one'),
    );
    ingest.dropTransientStaging
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('D1 hiccup on drop'));
    ingest.releaseRefreshLease.mockRejectedValueOnce(new Error('D1 hiccup on release'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wf = makeWorkflow();
    const names: string[] = [];

    await expect(
      wf.run({ payload: {}, instanceId: 'wf-80' } as never, fakeStep(names) as never),
    ).rejects.toThrow(/integrity gate failed: the real one/);

    const logged = error.mock.calls.map((c) => String(c[0]));
    expect(logged.some((l) => l.includes('etl_refresh_staging_drop_failed'))).toBe(true);
    expect(logged.some((l) => l.includes('etl_refresh_lease_release_failed'))).toBe(true);
  });

  it('reports a release failure on an otherwise successful run', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseContracts: 1 })]);
    ingest.releaseRefreshLease.mockRejectedValueOnce(new Error('D1 hiccup on release'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const wf = makeWorkflow();

    await expect(
      wf.run({ payload: {}, instanceId: 'wf-81' } as never, fakeStep([]) as never),
    ).rejects.toThrow(/D1 hiccup on release/);
  });

  it('reports the drop failure, not the release failure, when both fail on a successful run', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseContracts: 1 })]);
    ingest.dropTransientStaging
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('D1 hiccup on drop'));
    ingest.releaseRefreshLease.mockRejectedValueOnce(new Error('D1 hiccup on release'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const wf = makeWorkflow();

    await expect(
      wf.run({ payload: {}, instanceId: 'wf-82' } as never, fakeStep([]) as never),
    ).rejects.toThrow(/D1 hiccup on drop/);
  });
});

describe('RefreshWorkflow.run — the rarer branches of the lease paths', () => {
  it('steps aside with no holder known and no manual today: dates from now, holder omitted', async () => {
    ingest.acquireRefreshLease.mockResolvedValueOnce({
      acquired: false,
      holder: null,
      expiresAt: null,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wf = makeWorkflow();

    const result = await wf.run(
      { payload: {}, instanceId: 'wf-100' } as never,
      fakeStep([]) as never,
    );

    expect(result.skipped).toBe('lease-held');
    expect(result.leaseHolder).toBeUndefined();
    expect(result.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.to).toBe(result.from);
  });

  it('names "nobody" when the lease was lost and no holder is on record', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseContracts: 1 })]);
    ingest.renewRefreshLease.mockResolvedValueOnce({
      acquired: false,
      holder: null,
      expiresAt: null,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wf = makeWorkflow();

    await expect(
      wf.run({ payload: {}, instanceId: 'wf-101' } as never, fakeStep([]) as never),
    ).rejects.toThrow(/refresh lease lost before drop-stale-transient-staging: now held by nobody/);
  });

  it('stringifies non-Error rejections from the staging drop and the release', async () => {
    eop.computeWorkerCatchupPlan.mockResolvedValue(PLAN);
    eop.ingestBucketWindow.mockResolvedValue([dayResult({ baseContracts: 1 })]);
    ingest.dropTransientStaging
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce('drop said no');
    ingest.releaseRefreshLease.mockRejectedValueOnce('release said no');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wf = makeWorkflow();

    await expect(
      wf.run({ payload: {}, instanceId: 'wf-102' } as never, fakeStep([]) as never),
    ).rejects.toBe('drop said no');

    const logged = error.mock.calls.map(
      (c) => JSON.parse(String(c[0])) as { event: string; error: string },
    );
    expect(logged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'etl_refresh_staging_drop_failed',
          error: 'drop said no',
        }),
        expect.objectContaining({
          event: 'etl_refresh_lease_release_failed',
          error: 'release said no',
        }),
      ]),
    );
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
