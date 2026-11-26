/// <reference types="node" />
// End-to-end refresh Workflow test (#158): the cron path must load FX rates before the derive so
// foreign-currency contracts get a real amount_eur instead of silently dropping out of every
// rollup. Runs the real RefreshWorkflow.run() — real staging, real refresh-slice.sql derive —
// against a real SQLite behind the D1 facade, with storage.eop.bg and frankfurter fetches
// mocked deterministically (fixed rates, no live network).
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRANKFURTER_API } from '../../../packages/ingest/src/fx';
import { splitSqlStatements } from '../../../packages/ingest/src/refresh';
import { d1FromSqlite } from '@sigma/test-support';
import { RefreshWorkflow, type Env } from './index';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = resolve(root, 'packages/db/migrations');

const TODAY = '2026-07-10';
const BUCKET_DAY = '2026-07-09';
const CONTRACT_DATE = '2026-07-08';
const USD_VALUE = 120000;
const BGN_VALUE = 1000;
// ECB business-day rates only up to 2026-07-07: the contract date itself has no rate, so the
// derive must carry the latest prior rate forward (the 10-day lookback in refresh-slice.sql).
const USD_RATES: Record<string, { EUR: number }> = {
  '2026-07-06': { EUR: 0.86 },
  '2026-07-07': { EUR: 0.87 },
};
const USD_SERIES = {
  amount: 1,
  base: 'USD',
  start_date: '2026-07-06',
  end_date: '2026-07-07',
  rates: USD_RATES,
};
const EXPECTED_USD_EUR = USD_VALUE * 0.87;
const BGN_PEG = 1.95583;

function freshServedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(migrationsDir).sort()) {
    if (file.endsWith('.sql')) db.exec(readFileSync(resolve(migrationsDir, file), 'utf8'));
  }
  return db;
}

const bucketContracts = [
  {
    noticeId: 'DOC-FX-USD',
    publicationDate: BUCKET_DAY,
    uniqueProcurementNumber: 'UNP-FX-1',
    tenderId: 'TENDER-FX-1',
    procedureType: 'open',
    tenderName: 'FX tender',
    typeOfContract: 'services',
    buyerName: 'Authority FX',
    buyerRegistryNumber: '123456789',
    buyerType: 'public',
    lotIdentifier: '1',
    contractNumber: 'CONTRACT-FX-USD',
    contractDate: CONTRACT_DATE,
    contractValue: String(USD_VALUE),
    contractCurrency: 'USD',
    contractSubject: 'FX contract in USD',
    supplierRegisterNumber: '987654321',
    supplierName: 'Bidder FX',
    supplierNationality: 'BG',
    offersCount: '3',
  },
  {
    noticeId: 'DOC-FX-BGN',
    publicationDate: BUCKET_DAY,
    uniqueProcurementNumber: 'UNP-FX-2',
    tenderId: 'TENDER-FX-2',
    procedureType: 'open',
    tenderName: 'BGN tender',
    typeOfContract: 'services',
    buyerName: 'Authority FX',
    buyerRegistryNumber: '123456789',
    buyerType: 'public',
    lotIdentifier: '1',
    contractNumber: 'CONTRACT-FX-BGN',
    contractDate: CONTRACT_DATE,
    contractValue: String(BGN_VALUE),
    contractCurrency: 'BGN',
    contractSubject: 'Control contract in BGN',
    supplierRegisterNumber: '987654322',
    supplierName: 'Bidder BGN',
    supplierNationality: 'BG',
    offersCount: '2',
  },
];

const BUCKET_KEY = `договори-${BUCKET_DAY}.json`;

function stubFetchRoutes(): { frankfurterCalls: () => number } {
  let frankfurterCalls = 0;
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.startsWith(`${FRANKFURTER_API}/`)) {
      frankfurterCalls += 1;
      const base = new URL(url).searchParams.get('base');
      if (base === 'USD') {
        return Response.json(USD_SERIES);
      }
      return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    }

    const bucketUrl = `https://storage.eop.bg/open-data-${BUCKET_DAY}/`;
    if (url === bucketUrl) {
      const xml = `<ListBucketResult><Contents><Key>${BUCKET_KEY}</Key></Contents></ListBucketResult>`;
      return new Response(xml, { status: 200 });
    }
    if (url === `${bucketUrl}${encodeURIComponent(BUCKET_KEY)}`) {
      return new Response(JSON.stringify(bucketContracts), { status: 200 });
    }
    if (/^https:\/\/storage\.eop\.bg\/open-data-\d{4}-\d{2}-\d{2}\/$/.test(url)) {
      return new Response('no such bucket', { status: 404 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as unknown as typeof fetch);
  return { frankfurterCalls: () => frankfurterCalls };
}

const fakeStep: WorkflowStep = {
  async do<T>(
    _name: string,
    configOrCallback: Record<string, unknown> | (() => Promise<T>),
    maybeCallback?: () => Promise<T>,
  ): Promise<T> {
    const callback =
      typeof configOrCallback === 'function'
        ? configOrCallback
        : (maybeCallback as () => Promise<T>);
    return callback();
  },
} as WorkflowStep;

function makeWorkflow(db: DatabaseSync): RefreshWorkflow {
  const env: Env = {
    DB: d1FromSqlite(db),
    REFRESH: undefined as unknown as Workflow,
    EOP_OPEN_DATA_BASE_URL: 'https://storage.eop.bg',
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  return new RefreshWorkflow(ctx, env);
}

function runRefresh(workflow: RefreshWorkflow) {
  const event = {
    payload: { today: TODAY },
    timestamp: new Date(`${TODAY}T00:00:00Z`),
    instanceId: 'test-run',
  } as WorkflowEvent<{ today: string }>;
  return workflow.run(event, fakeStep);
}

describe('RefreshWorkflow FX loading (#158)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prices a staged foreign-currency contract in EUR during the cron refresh', async () => {
    const db = freshServedDb();
    const { frankfurterCalls } = stubFetchRoutes();

    const result = await runRefresh(makeWorkflow(db));
    expect(result.staged).toBe(2);
    expect(result.derived).toBeGreaterThanOrEqual(0);

    const fxRows = db
      .prepare("SELECT COUNT(*) AS n FROM fx_rates WHERE source = 'ecb:frankfurter'")
      .get() as { n: number };
    expect(fxRows.n).toBe(Object.keys(USD_RATES).length);
    expect(frankfurterCalls()).toBe(1);

    const usd = db
      .prepare(
        "SELECT amount_eur, currency FROM contracts WHERE contract_number = 'CONTRACT-FX-USD'",
      )
      .get() as { amount_eur: number | null; currency: string };
    expect(usd.currency).toBe('USD');
    // THE BUG (#158): without an FX load in the cron path this is NULL and the contract silently
    // drops out of every rollup and total.
    expect(usd.amount_eur).not.toBeNull();
    expect(usd.amount_eur).toBeCloseTo(EXPECTED_USD_EUR, 2);
  });

  it.each([
    { failure: () => new Response('unavailable', { status: 503 }), error: 'HTTP 503' },
    { failure: () => Response.json({ message: 'unavailable' }), error: 'malformed FX series' },
    {
      failure: () => Response.json({ ...USD_SERIES, base: undefined }),
      error: 'invalid series metadata',
    },
    {
      failure: () => Response.json({ ...USD_SERIES, end_date: '2026-07-05' }),
      error: 'invalid series metadata',
    },
  ])('requests FX before writes and recovers from $error', async ({ failure, error }) => {
    const db = freshServedDb();
    const annexKey = `анекси-${BUCKET_DAY}.json`;
    const base = {
      ...bucketContracts[0],
      contractNumber: 'TEST-FX-ANCHOR',
      contractCurrency: 'EUR',
      contractValue: '10000',
      supplierRegisterNumber: '0000000000015',
    };
    const anchor = {
      ...base,
      noticeId: 'TEST-ANCHOR',
      contractNumber: 'TEST-FOREIGN-NUMBER',
      lastContractValue: '10000',
      currentContractValue: '11000',
      contractValueDifference: '1000',
    };
    const dollarAnnex = {
      ...anchor,
      noticeId: 'TEST-USD',
      contractCurrency: 'USD',
      lastContractValue: '12000',
      currentContractValue: '15000',
      contractValueDifference: '3000',
    };
    const note = { ...base, noticeId: 'TEST-METADATA' };
    let key = BUCKET_KEY;
    let records: object[] = [base];
    let fail = true;
    const fxRequests: string[] = [];
    const bucket = `https://storage.eop.bg/open-data-${BUCKET_DAY}/`;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === bucket)
        return new Response(
          `<ListBucketResult><Contents><Key>${key}</Key></Contents></ListBucketResult>`,
        );
      if (url === bucket + encodeURIComponent(key)) return Response.json(records);
      if (url.startsWith(FRANKFURTER_API)) {
        fxRequests.push(url);
        return fail ? failure() : Response.json(USD_SERIES);
      }
      return new Response('no such bucket', { status: 404 });
    });
    const workflow = makeWorkflow(db);
    await runRefresh(workflow);
    expect(fxRequests).toEqual([]);
    const home = () => db.prepare('SELECT as_of, value_eur FROM home_totals').get();
    expect(home()).toEqual({ as_of: CONTRACT_DATE, value_eur: 10_000 });

    key = annexKey;
    records = [anchor, dollarAnnex];
    await expect(runRefresh(workflow)).rejects.toThrow(
      new RegExp(`FX load failed with coverage gaps remaining: USD.*${error}`),
    );
    const expectedRequest = `${FRANKFURTER_API}/2026-06-28..2026-07-08?base=USD&symbols=EUR`;
    expect(fxRequests).toEqual([expectedRequest]);
    expect(home()).toEqual({ as_of: CONTRACT_DATE, value_eur: 10_000 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM amendments').get()?.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM refresh_pending_window').get()?.n).toBe(1);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM sqlite_schema WHERE name GLOB 'raw_*'
            OR name IN ('refresh_amendment_rekeyed', 'contractor_identity')`,
        )
        .get()?.n,
    ).toBe(0);

    fail = false;
    await runRefresh(workflow);
    expect(fxRequests).toEqual([expectedRequest, expectedRequest]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM refresh_pending_window').get()?.n).toBe(0);
    expect(
      db
        .prepare(
          'SELECT contract_number, contract_number_raw, link_method FROM amendments ORDER BY document_number',
        )
        .all(),
    ).toEqual(
      Array(2).fill({
        contract_number: 'TEST-FX-ANCHOR',
        contract_number_raw: 'TEST-FOREIGN-NUMBER',
        link_method: 'value_anchor',
      }),
    );
    expect(home()).toEqual({ as_of: CONTRACT_DATE, value_eur: 13_050 });

    records = [note];
    await runRefresh(workflow);
    expect(fxRequests).toEqual([expectedRequest, expectedRequest]);
    expect(home()).toEqual({ as_of: CONTRACT_DATE, value_eur: 13_050 });
    expect(
      db
        .prepare(
          'SELECT current_value, current_value_currency, current_value_eur, value_flag FROM contracts',
        )
        .get(),
    ).toEqual({
      current_value: 15_000,
      current_value_currency: 'USD',
      current_value_eur: 13_050,
      value_flag: 'ok',
    });
  });

  it('keeps BGN contracts on the fixed peg (no FX regression)', async () => {
    const db = freshServedDb();
    stubFetchRoutes();

    await runRefresh(makeWorkflow(db));

    const bgn = db
      .prepare("SELECT amount_eur FROM contracts WHERE contract_number = 'CONTRACT-FX-BGN'")
      .get() as { amount_eur: number | null };
    expect(bgn.amount_eur).toBeCloseTo(BGN_VALUE / BGN_PEG, 2);
  });

  it('re-runs idempotently: no duplicate rates, no redundant FX fetch, stable amounts', async () => {
    const db = freshServedDb();
    const { frankfurterCalls } = stubFetchRoutes();
    const workflow = makeWorkflow(db);

    await runRefresh(workflow);
    const firstCalls = frankfurterCalls();
    await runRefresh(workflow);

    // The staged window is already covered by fx_rates, so the second run must not re-fetch.
    expect(frankfurterCalls()).toBe(firstCalls);
    const fxRows = db.prepare('SELECT COUNT(*) AS n FROM fx_rates').get() as { n: number };
    expect(fxRows.n).toBe(Object.keys(USD_RATES).length);

    const usd = db
      .prepare("SELECT amount_eur FROM contracts WHERE contract_number = 'CONTRACT-FX-USD'")
      .get() as { amount_eur: number | null };
    expect(usd.amount_eur).toBeCloseTo(EXPECTED_USD_EUR, 2);
  });
});

// The Workers runtime logs an error on every *successful* instance of this Workflow, so the absence
// of errors proves nothing about whether the cron actually ran. A finished refresh has to announce
// itself — and, just as importantly, a failed one must not.
describe('RefreshWorkflow completion signal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function captureLogs(): () => Record<string, unknown>[] {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    return () =>
      lines.flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  }

  it('announces a finished refresh with the run summary', async () => {
    const db = freshServedDb();
    stubFetchRoutes();
    const logs = captureLogs();

    const result = await runRefresh(makeWorkflow(db));

    const done = logs().find((e) => e.event === 'etl_refresh_complete');
    expect(done).toBeDefined();
    expect(done?.staged).toBe(result.staged);
    expect(done?.derived).toBe(result.derived);
    expect(done?.to).toBe(TODAY);
  });

  it('stays silent when the refresh throws', async () => {
    const db = freshServedDb();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('storage.eop.bg unreachable');
      }) as unknown as typeof fetch,
    );
    const logs = captureLogs();

    await expect(runRefresh(makeWorkflow(db))).rejects.toThrow(/storage\.eop\.bg unreachable/);

    expect(logs().some((e) => e.event === 'etl_refresh_complete')).toBe(false);
  });
});

// A refresh that dies between `derive-slice:contracts` and the rollups has already committed the new
// contracts (each group is one atomic batch). Until 2026-09-02 the next run threw away the record of
// what they touched and, because an aborted run leaves a three-day lookback, never rolled them up:
// nineteen days of runs dying at `amendments` (SQLITE_NOMEM, #342) left 276 authorities and 481
// bidders whose rollups no longer summed to their contracts. This is that incident, end to end, on the
// real Workflow, the real refresh-slice.sql and the real served gate — run 1 dies exactly where staging
// did, run 2 has NOTHING new to stage, and must still finish run 1's rollups and pass the gate.
describe('RefreshWorkflow — an aborted derive is finished by the next run', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const eventFor = (today: string) =>
    ({
      payload: { today },
      timestamp: new Date(`${today}T00:00:00Z`),
      instanceId: `test-${today}`,
    }) as WorkflowEvent<{ today: string }>;

  // The step runner staging had: every step runs for real, except the one that throws before its
  // body — the batch never starts, exactly like a D1 error rolling the whole group back.
  const dyingAt = (step: string): WorkflowStep =>
    ({
      async do<T>(
        name: string,
        configOrCallback: Record<string, unknown> | (() => Promise<T>),
        maybeCallback?: () => Promise<T>,
      ): Promise<T> {
        if (name === step) throw new Error('D1_ERROR: out of memory: SQLITE_NOMEM');
        const callback =
          typeof configOrCallback === 'function'
            ? configOrCallback
            : (maybeCallback as () => Promise<T>);
        return callback();
      },
    }) as WorkflowStep;

  const count = (db: DatabaseSync, table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const tableExists = (db: DatabaseSync, table: string): boolean =>
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { n: number }
    ).n === 1;
  const pendingRows = (db: DatabaseSync) =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'refresh_pending_window'",
        )
        .get() as { n: number }
    ).n === 0
      ? []
      : (db
          .prepare(
            'SELECT window_from, window_to, holder FROM refresh_pending_window ORDER BY window_from, holder',
          )
          .all() as { window_from: string; window_to: string; holder: string }[]);

  it('run 2 REPLAYS the window run 1 left unfinished, re-deriving it whole and passing the gate', async () => {
    const db = freshServedDb();
    stubFetchRoutes();
    const workflow = makeWorkflow(db);

    await expect(workflow.run(eventFor(TODAY), dyingAt('derive-slice:amendments'))).rejects.toThrow(
      /SQLITE_NOMEM/,
    );
    // Run 1 recorded its window before staging anything and died before clearing it.
    expect(pendingRows(db)).toEqual([
      { window_from: '2026-07-07', window_to: TODAY, holder: 'test-2026-07-10' },
    ]);
    expect(count(db, 'contracts')).toBe(2);
    expect(count(db, 'authority_totals')).toBe(0);

    // Run 2 ten days later: its own lookback (07-17..07-20) would miss the 07-09 bucket entirely,
    // but the unfinished window is folded in, so the bucket is staged and derived again — every group
    // sees one consistent staging, which is what the touched sets alone cannot give.
    const result = await workflow.run(eventFor('2026-07-20'), fakeStep);
    expect(result.replayFrom).toBe('2026-07-07');
    expect(result.from).toBe('2026-07-07');
    expect(result.staged).toBe(2);
    expect(result.skipped).toBeUndefined(); // run() resolving = integrity-gate passed
    const auth = db.prepare('SELECT spent_eur, contracts FROM authority_totals').all() as {
      spent_eur: number;
      contracts: number;
    }[];
    expect(auth).toHaveLength(1);
    expect(auth[0]!.contracts).toBe(2);
    expect(auth[0]!.spent_eur).toBeCloseTo(EXPECTED_USD_EUR + BGN_VALUE / BGN_PEG, 2);
    expect(pendingRows(db), 'settled after the gate passed').toEqual([]);
    expect(tableExists(db, 'refresh_touched_contracts')).toBe(false);
  });

  it('run 2 with nothing to stage (replay capped away) still rolls up what run 1 inserted before dying', async () => {
    const db = freshServedDb();
    stubFetchRoutes();
    const workflow = makeWorkflow(db);

    await expect(workflow.run(eventFor(TODAY), dyingAt('derive-slice:amendments'))).rejects.toThrow(
      /SQLITE_NOMEM/,
    );
    // Run 1 committed its two contracts and the ids it touched — and no rollups.
    expect(count(db, 'contracts')).toBe(2);
    expect(count(db, 'authority_totals')).toBe(0);
    expect(count(db, 'refresh_touched_contracts')).toBe(2);
    expect(count(db, 'refresh_touched_authorities')).toBe(1);
    expect(count(db, 'refresh_touched_bidders')).toBe(2);
    // Far enough ahead that the replay (from 07-07) exceeds the 21-day cap: the plan is capped to the
    // last 21 days, the 07-09 bucket is outside it and every day is 404 — nothing staged. This is the
    // case the touched sets exist for: what a replay cannot cover, they still roll up.
    const later = '2026-08-15';
    const result = await workflow.run(eventFor(later), fakeStep);

    expect(result.capped).toBe(true);
    expect(result.staged).toBe(0);
    expect(result.pendingTouched).toBe(5);
    // Run 1's whole promise (07-07 … 07-10) lies before the capped start, so it stays on record
    // exactly as run 1 made it; run 2's own promise was settled by its own coverage.
    expect(pendingRows(db)).toEqual([
      { window_from: '2026-07-07', window_to: TODAY, holder: 'test-2026-07-10' },
    ]);
    // run() resolving means integrity-gate passed on the served DB — rollup-reconciliation included.
    const auth = db.prepare('SELECT spent_eur, contracts FROM authority_totals').all() as {
      spent_eur: number;
      contracts: number;
    }[];
    expect(auth).toHaveLength(1);
    expect(auth[0]!.contracts).toBe(2);
    expect(auth[0]!.spent_eur).toBeCloseTo(EXPECTED_USD_EUR + BGN_VALUE / BGN_PEG, 2);
    const won = db.prepare('SELECT SUM(won_eur) AS s, COUNT(*) AS n FROM company_totals').get() as {
      s: number;
      n: number;
    };
    expect(won.n).toBe(2);
    expect(won.s).toBeCloseTo(EXPECTED_USD_EUR + BGN_VALUE / BGN_PEG, 2);
    // A completed run leaves no touched tables behind.
    expect(tableExists(db, 'refresh_touched_contracts')).toBe(false);
    expect(tableExists(db, 'refresh_touched_bidders')).toBe(false);
    expect(tableExists(db, 'refresh_touched_authorities')).toBe(false);
  });

  it('a clean run followed by an empty window still short-circuits: nothing is pending', async () => {
    const db = freshServedDb();
    stubFetchRoutes();
    const workflow = makeWorkflow(db);
    const first = await workflow.run(eventFor(TODAY), fakeStep);
    expect(first.staged).toBe(2);
    expect(first.pendingTouched).toBe(0);
    // Far enough ahead that the (capped) window no longer covers the 07-09 bucket: nothing staged.
    expect(pendingRows(db), 'a completed run leaves no promise behind').toEqual([]);
    const result = await workflow.run(eventFor('2026-08-15'), fakeStep);
    expect(result).toMatchObject({ staged: 0, derived: 0, pendingTouched: 0 });
    expect(count(db, 'authority_totals')).toBe(1); // untouched by the short-circuit
    expect(pendingRows(db), 'an empty, fully covered window is not left pending').toEqual([]);
  });
});

// Refresh writers share every scratch table on the served D1, and the touched sets now outlive a run,
// so two overlapping instances could drop each other's records. The lease serialises them: a live
// holder makes a newcomer step aside untouched; an expired one is taken over; it is always released.
describe('RefreshWorkflow — window replay repairs what the touched sets cannot', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const eventFor = (today: string) =>
    ({
      payload: { today },
      timestamp: new Date(`${today}T00:00:00Z`),
      instanceId: `replay-${today}`,
    }) as WorkflowEvent<{ today: string }>;
  const count = (db: DatabaseSync, table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const pendingRows = (db: DatabaseSync) =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'refresh_pending_window'",
        )
        .get() as { n: number }
    ).n === 0
      ? []
      : (db
          .prepare(
            'SELECT window_from, window_to, holder FROM refresh_pending_window ORDER BY window_from, holder',
          )
          .all() as { window_from: string; window_to: string; holder: string }[]);
  const dyingAt = (step: string): WorkflowStep =>
    ({
      async do<T>(
        name: string,
        configOrCallback: Record<string, unknown> | (() => Promise<T>),
        maybeCallback?: () => Promise<T>,
      ): Promise<T> {
        if (name === step) throw new Error('D1_ERROR: out of memory: SQLITE_NOMEM');
        const callback =
          typeof configOrCallback === 'function'
            ? configOrCallback
            : (maybeCallback as () => Promise<T>);
        return callback();
      },
    }) as WorkflowStep;

  it('a run that died BEFORE its contracts were derived is completed by the replay, not by touched ids', async () => {
    const db = freshServedDb();
    stubFetchRoutes();
    const workflow = makeWorkflow(db);
    // Dies on the way into `contracts`: the tender headers of the window are in, the contracts are
    // not — nothing for the touched sets to roll up, nothing a three-day lookback would revisit.
    await expect(workflow.run(eventFor(TODAY), dyingAt('derive-slice:contracts'))).rejects.toThrow(
      /SQLITE_NOMEM/,
    );
    expect(count(db, 'contracts')).toBe(0);
    expect(count(db, 'refresh_touched_contracts')).toBe(0);
    expect(pendingRows(db)[0]?.window_from).toBe('2026-07-07');

    const result = await workflow.run(eventFor('2026-07-20'), fakeStep);
    expect(result.replayFrom).toBe('2026-07-07');
    expect(result.staged).toBe(2);
    expect(count(db, 'contracts')).toBe(2); // only a replay can produce these
    expect(count(db, 'authority_totals')).toBe(1);
    expect(pendingRows(db)).toEqual([]);
  });

  it('an inherited promise is never certified by an empty ingest: derive and gate run, but it stays until a run sees data', async () => {
    const db = freshServedDb();
    stubFetchRoutes();
    // A served corpus exists (a clean run), then an earlier run promised 07-12 … 07-14 (no buckets
    // exist for those days) and died right after recording it — e.g. in `setup`, with no touched
    // ids at all.
    await makeWorkflow(db).run(eventFor(TODAY), fakeStep);
    db.exec(
      `CREATE TABLE IF NOT EXISTS refresh_pending_window (holder TEXT NOT NULL, window_from TEXT NOT NULL, window_to TEXT NOT NULL, started_at TEXT NOT NULL, PRIMARY KEY (holder, window_from));
       INSERT INTO refresh_pending_window VALUES ('dead', '2026-07-12', '2026-07-14', '2026-07-14T00:00:05.000Z');`,
    );
    const names: string[] = [];
    const recording: WorkflowStep = {
      async do<T>(
        name: string,
        configOrCallback: Record<string, unknown> | (() => Promise<T>),
        maybeCallback?: () => Promise<T>,
      ): Promise<T> {
        names.push(name);
        const callback =
          typeof configOrCallback === 'function'
            ? configOrCallback
            : (maybeCallback as () => Promise<T>);
        return callback();
      },
    } as WorkflowStep;

    // 07-31: the own lookback (07-05 …) merged with the promise is capped to 07-11 … 07-31 — the
    // 07-09 bucket is outside it and every day answers "no bucket": nothing staged, no evidence the
    // source answers. The derive and the gate run, the run's own promise settles, the inherited
    // one is held back — with a warning — rather than certified by silence.
    const held = await makeWorkflow(db).run(eventFor('2026-07-31'), recording);
    expect(held.staged).toBe(0);
    expect(held.capped).toBe(true);
    expect(held.skipped).toBeUndefined();
    expect(names).not.toContain('settle-windows-empty');
    expect(names.some((n) => n.startsWith('derive-slice:'))).toBe(true);
    expect(names).toContain('integrity-gate');
    expect(names.indexOf('settle-windows')).toBeGreaterThan(names.indexOf('integrity-gate'));
    expect(held.uncoveredWindows).toBe(1);
    expect(pendingRows(db)).toEqual([
      { window_from: '2026-07-12', window_to: '2026-07-14', holder: 'dead' },
    ]);

    // A run whose window includes a day that HAS a bucket (07-09) has proven the source answers:
    // its absent days are genuinely empty, and the inherited promise is settled.
    const seen = await makeWorkflow(db).run(eventFor('2026-07-20'), fakeStep);
    expect(seen.staged).toBe(2);
    expect(seen.uncoveredWindows).toBe(0);
    expect(pendingRows(db)).toEqual([]);
  });
});

describe('RefreshWorkflow — promises only shrink across interrupted replays', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const eventFor = (today: string, instanceId: string, maxWindowDays?: number) =>
    ({
      payload: maxWindowDays ? { today, maxWindowDays } : { today },
      timestamp: new Date(`${today}T00:00:00Z`),
      instanceId,
    }) as WorkflowEvent<{ today: string; maxWindowDays?: number }>;
  const spans = (db: DatabaseSync) =>
    (
      db
        .prepare(
          'SELECT holder, window_from, window_to FROM refresh_pending_window ORDER BY window_from, holder',
        )
        .all() as { holder: string; window_from: string; window_to: string }[]
    ).map((r) => `${r.holder}:${r.window_from}..${r.window_to}`);
  const dyingAt = (step: string): WorkflowStep =>
    ({
      async do<T>(
        name: string,
        configOrCallback: Record<string, unknown> | (() => Promise<T>),
        maybeCallback?: () => Promise<T>,
      ): Promise<T> {
        if (name === step) throw new Error('boom');
        const callback =
          typeof configOrCallback === 'function'
            ? configOrCallback
            : (maybeCallback as () => Promise<T>);
        return callback();
      },
    }) as WorkflowStep;

  it('A dies, B capped, C dies after recording, D capped, E wide: no promise ever grows', async () => {
    const db = freshServedDb();
    stubFetchRoutes();
    const workflow = makeWorkflow(db);
    // A: promises 07-07..07-10, stages the bucket, dies at amendments.
    await expect(
      workflow.run(eventFor(TODAY, 'A'), dyingAt('derive-slice:amendments')),
    ).rejects.toThrow();
    expect(spans(db)).toEqual(['A:2026-07-07..2026-07-10']);
    // B on 08-15: the hull 07-07..08-15 is capped to 07-26..08-15 — records exactly that, succeeds.
    const b = await workflow.run(eventFor('2026-08-15', 'B'), fakeStep);
    expect(b.capped).toBe(true);
    expect(b.uncoveredWindows).toBe(1);
    expect(spans(db)).toEqual(['A:2026-07-07..2026-07-10']);
    // C on 08-16: capped to 07-27..08-16, records it, dies at ingest.
    await expect(
      workflow.run(eventFor('2026-08-16', 'C'), dyingAt('ingest-storage-eop-bucket')),
    ).rejects.toThrow(/boom/);
    expect(spans(db)).toEqual(['A:2026-07-07..2026-07-10', 'C:2026-07-27..2026-08-16']);
    // D on 08-17: capped to 07-28..08-17, succeeds — but every day answered "no bucket", so D has
    // no evidence the source answers and C's promise is held back untouched (D's own is settled).
    // Nothing ever widened to include the days B already applied.
    const d = await workflow.run(eventFor('2026-08-17', 'D'), fakeStep);
    expect(d.uncoveredWindows).toBe(2);
    expect(spans(db)).toEqual(['A:2026-07-07..2026-07-10', 'C:2026-07-27..2026-08-16']);
    // E: an operator's manual trigger wide enough to span both AND to reach the 07-09 bucket (the
    // source answers) — everything settles.
    const e = await workflow.run(eventFor('2026-08-17', 'E', 60), fakeStep);
    expect(e.capped).toBe(false);
    expect(e.replayFrom).toBe('2026-07-07');
    expect(e.uncoveredWindows).toBe(0);
    expect(spans(db)).toEqual([]);
  });
});

describe('RefreshWorkflow — refresh lease', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const eventFor = (today: string, instanceId: string) =>
    ({
      payload: { today },
      timestamp: new Date(`${today}T00:00:00Z`),
      instanceId,
    }) as WorkflowEvent<{ today: string }>;
  const leaseRow = (db: DatabaseSync) =>
    db.prepare('SELECT holder, expires_at FROM refresh_lease WHERE id = 1').get() as
      { holder: string; expires_at: string } | undefined;
  const plantLease = (db: DatabaseSync, holder: string, expiresAt: string) =>
    db.exec(
      `CREATE TABLE IF NOT EXISTS refresh_lease (id INTEGER PRIMARY KEY CHECK (id = 1), holder TEXT NOT NULL, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL);
       INSERT INTO refresh_lease (id, holder, acquired_at, expires_at) VALUES (1, '${holder}', '2026-07-10T00:00:00.000Z', '${expiresAt}');`,
    );

  it('steps aside without touching the DB while another live instance holds the lease', async () => {
    const db = freshServedDb();
    stubFetchRoutes();
    plantLease(db, 'cron-live', '2999-01-01T00:00:00.000Z');
    const result = await makeWorkflow(db).run(eventFor(TODAY, 'manual-1'), fakeStep);
    expect(result).toMatchObject({ skipped: 'lease-held', leaseHolder: 'cron-live', staged: 0 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM contracts').get() as { n: number }).n).toBe(0);
    expect(leaseRow(db)).toEqual({ holder: 'cron-live', expires_at: '2999-01-01T00:00:00.000Z' });
  });

  it('takes over an expired lease, refreshes, and releases it', async () => {
    const db = freshServedDb();
    stubFetchRoutes();
    plantLease(db, 'cron-hung', '2000-01-01T00:00:00.000Z');
    const result = await makeWorkflow(db).run(eventFor(TODAY, 'cron-2'), fakeStep);
    expect(result.skipped).toBeUndefined();
    expect(result.staged).toBe(2);
    expect(leaseRow(db), 'released in finally').toBeUndefined();
  });

  it('releases the lease when the run dies mid-derive, so the next cron is not fenced out', async () => {
    const db = freshServedDb();
    stubFetchRoutes();
    const workflow = makeWorkflow(db);
    const dying: WorkflowStep = {
      async do<T>(
        name: string,
        configOrCallback: Record<string, unknown> | (() => Promise<T>),
        maybeCallback?: () => Promise<T>,
      ): Promise<T> {
        if (name === 'derive-slice:amendments')
          throw new Error('D1_ERROR: out of memory: SQLITE_NOMEM');
        const callback =
          typeof configOrCallback === 'function'
            ? configOrCallback
            : (maybeCallback as () => Promise<T>);
        return callback();
      },
    } as WorkflowStep;
    await expect(workflow.run(eventFor(TODAY, 'cron-3'), dying)).rejects.toThrow(/SQLITE_NOMEM/);
    expect(leaseRow(db)).toBeUndefined();
    // …and the next run is free to finish its rollups.
    const next = await workflow.run(eventFor('2026-07-20', 'cron-4'), fakeStep);
    expect(next.skipped).toBeUndefined();
    expect(next.pendingTouched).toBeGreaterThan(0);
  });
});

// The fence: a run that lost its lease mid-way (a retried step outlasted the TTL and a newer instance
// took over) must stop before its next write and leave the newer instance's staging alone.
describe('RefreshWorkflow — lease fence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stops before the next derive batch once another instance holds the lease, keeping its hands off staging', async () => {
    const db = freshServedDb();
    stubFetchRoutes();
    const workflow = makeWorkflow(db);
    // Every step runs for real; right before `derive-slice:amendments` a newer instance takes the
    // lease (as it would after this run stalled past the TTL).
    const usurped: WorkflowStep = {
      async do<T>(
        name: string,
        configOrCallback: Record<string, unknown> | (() => Promise<T>),
        maybeCallback?: () => Promise<T>,
      ): Promise<T> {
        if (name === 'derive-slice:amendments') {
          db.exec(
            "UPDATE refresh_lease SET holder = 'usurper', expires_at = '2999-01-01T00:00:00.000Z' WHERE id = 1",
          );
        }
        const callback =
          typeof configOrCallback === 'function'
            ? configOrCallback
            : (maybeCallback as () => Promise<T>);
        return callback();
      },
    } as WorkflowStep;
    const event = {
      payload: { today: TODAY },
      timestamp: new Date(`${TODAY}T00:00:00Z`),
      instanceId: 'stalled',
    } as WorkflowEvent<{ today: string }>;

    await expect(workflow.run(event, usurped)).rejects.toThrow(
      /refresh lease lost before derive-slice:amendments: now held by usurper/,
    );

    const count = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const exists = (table: string) =>
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table) as { n: number }
      ).n === 1;
    // `contracts` had committed before the fence fired; nothing after it ran.
    expect(count('contracts')).toBe(2);
    expect(count('authority_totals')).toBe(0);
    // The staging tables are the usurper's now — left in place, not dropped by the stalled run.
    expect(exists('raw_contracts')).toBe(true);
    // The usurper's lease is untouched: release is holder-qualified.
    expect(
      db.prepare('SELECT holder FROM refresh_lease WHERE id = 1').get() as { holder: string },
    ).toEqual({ holder: 'usurper' });
    // And what the stalled run DID commit is recorded for whoever finishes it.
    expect(count('refresh_touched_contracts')).toBe(2);
  });
});

// What the site says about its own data moves WITH the data, in the same D1 batch, and is never NULL:
// „последен договор" (home_totals.as_of) is written in the `contracts` batch, together with the contract
// rows it describes; the data generation (home_totals.refreshed_at: /health, X-Sigma-Generation, „данни
// обновени") moves before the first served row of a run changes and again after the last. Whether the
// numbers are verified is the stored verdict's business, not the date's. Every ending of a run is held to
// one invariant: the date equals what scripts/precompute.sql would write for the rows being served.
describe('RefreshWorkflow — the as-of date and the generation move with the served data', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A second, later bucket on top of the base one: a run on NEXT_TODAY stages one contract, signed on
  // NEXT_CONTRACT_DATE, after the CONTRACT_DATE the first run serves.
  const NEXT_TODAY = '2026-07-13';
  const NEXT_BUCKET_DAY = '2026-07-12';
  const NEXT_CONTRACT_DATE = '2026-07-11';
  const NEXT_KEY = `договори-${NEXT_BUCKET_DAY}.json`;
  const nextContract = {
    ...bucketContracts[1]!,
    noticeId: 'DOC-NEXT',
    publicationDate: NEXT_BUCKET_DAY,
    uniqueProcurementNumber: 'UNP-NEXT-1',
    tenderId: 'TENDER-NEXT-1',
    tenderName: 'Next tender',
    buyerName: 'Община Тест',
    contractNumber: 'CONTRACT-NEXT',
    contractDate: NEXT_CONTRACT_DATE,
    contractSubject: 'A later contract',
    supplierName: 'ТЕСТ ГРУП ЕООД',
  };
  function stubTwoBuckets(): void {
    stubFetchRoutes();
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      const url = String(input);
      const bucketUrl = `https://storage.eop.bg/open-data-${NEXT_BUCKET_DAY}/`;
      if (url === bucketUrl) {
        return new Response(
          `<ListBucketResult><Contents><Key>${NEXT_KEY}</Key></Contents></ListBucketResult>`,
          { status: 200 },
        );
      }
      if (url === `${bucketUrl}${encodeURIComponent(NEXT_KEY)}`) {
        return new Response(JSON.stringify([nextContract]), { status: 200 });
      }
      return base(input);
    }) as unknown as typeof fetch);
  }

  const eventFor = (today: string, instanceId = `test-${today}`) =>
    ({
      payload: { today },
      timestamp: new Date(`${today}T00:00:00Z`),
      instanceId,
    }) as WorkflowEvent<{ today: string }>;

  // Every step runs for real, except: `dieAt` throws before its body (the batch never starts, as when a
  // D1 error rolls the whole group back); `after[name]` runs once the step's body has committed.
  const runner = (
    opts: { dieAt?: string; after?: Record<string, () => Promise<void> | void> } = {},
  ): WorkflowStep =>
    ({
      async do<T>(
        name: string,
        configOrCallback: Record<string, unknown> | (() => Promise<T>),
        maybeCallback?: () => Promise<T>,
      ): Promise<T> {
        if (name === opts.dieAt) throw new Error('D1_ERROR: out of memory: SQLITE_NOMEM');
        const callback =
          typeof configOrCallback === 'function'
            ? configOrCallback
            : (maybeCallback as () => Promise<T>);
        const result = await callback();
        await opts.after?.[name]?.();
        return result;
      },
    }) as WorkflowStep;

  // What the site reads, and the truth it must match.
  const served = (db: DatabaseSync) =>
    db
      .prepare(
        `SELECT as_of AS asOf, refreshed_at AS generation,
           (SELECT MAX(signed_at) FROM contracts) AS newestContract,
           (SELECT COUNT(*) FROM contracts) AS contracts
         FROM home_totals WHERE id = 1`,
      )
      .get() as {
      asOf: string | null;
      generation: string;
      newestContract: string;
      contracts: number;
    };

  // The as_of expression of the full build, read out of scripts/precompute.sql rather than restated, and
  // evaluated over the rows the slot serves right now: what a rebuild of this slot would write.
  const PRECOMPUTE_AS_OF = (() => {
    const insert = splitSqlStatements(
      readFileSync(resolve(root, 'scripts/precompute.sql'), 'utf8'),
    ).find((s) => /^INSERT INTO home_totals\b/.test(s))!;
    const [, columns, select] = insert.match(
      /^INSERT INTO home_totals \(([^)]*)\)\s*SELECT\s+([\s\S]*)$/,
    )!;
    const items: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of select!) {
      if (ch === ',' && depth === 0) {
        items.push(current.trim());
        current = '';
        continue;
      }
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      current += ch;
    }
    items.push(current.trim());
    const at = columns!
      .split(',')
      .map((c) => c.trim())
      .indexOf('as_of');
    return items[at]!;
  })();
  const expectDateMatchesServedContracts = (db: DatabaseSync) => {
    const rebuilt = (db.prepare(`SELECT ${PRECOMPUTE_AS_OF} AS v`).get() as { v: string | null }).v;
    expect(rebuilt).not.toBeNull();
    expect(served(db).asOf).toBe(rebuilt);
  };

  // datetime('now') does not move between two runs inside one second, so the generation is pinned to an
  // earlier instant between runs: a later write is then visible.
  const STAMP = '2026-07-10 00:31:00';
  const pinGeneration = (db: DatabaseSync, at = STAMP) =>
    db.exec(`UPDATE home_totals SET refreshed_at = '${at}' WHERE id = 1`);
  async function firstRun(db: DatabaseSync) {
    const first = await makeWorkflow(db).run(eventFor(TODAY), fakeStep);
    expect(first.integrity).toBe('ok');
    pinGeneration(db);
    expect(served(db)).toMatchObject({ asOf: CONTRACT_DATE, generation: STAMP, contracts: 2 });
    expectDateMatchesServedContracts(db);
  }
  const pending = (db: DatabaseSync) =>
    (db.prepare('SELECT COUNT(*) AS n FROM refresh_pending_window').get() as { n: number }).n;
  const verdict = (db: DatabaseSync) =>
    db
      .prepare('SELECT verdict, checks FROM refresh_verdict ORDER BY decided_at DESC LIMIT 1')
      .get() as { verdict: string; checks: string } | undefined;
  const plannerAsOf = (db: DatabaseSync) =>
    (db.prepare("SELECT as_of FROM data_freshness WHERE source = 'eop'").get() as { as_of: string })
      .as_of;

  it('a run that dies before any served row changes moves neither the date nor the generation', async () => {
    const db = freshServedDb();
    stubTwoBuckets();
    await firstRun(db);

    await expect(
      makeWorkflow(db).run(eventFor(NEXT_TODAY), runner({ dieAt: 'derive-slice:setup' })),
    ).rejects.toThrow(/SQLITE_NOMEM/);
    expect(served(db)).toMatchObject({ asOf: CONTRACT_DATE, generation: STAMP, contracts: 2 });
    expectDateMatchesServedContracts(db);
  });

  it('a run that dies right before `contracts` keeps the previous date, never NULL, and moves the generation', async () => {
    const db = freshServedDb();
    stubTwoBuckets();
    await firstRun(db);

    await expect(
      makeWorkflow(db).run(eventFor(NEXT_TODAY), runner({ dieAt: 'derive-slice:contracts' })),
    ).rejects.toThrow(/SQLITE_NOMEM/);
    const after = served(db);
    // Served rows have changed (tenders, parties) but no contract has: the date stays where it was.
    expect(after).toMatchObject({ asOf: CONTRACT_DATE, contracts: 2 });
    expect(after.generation > STAMP).toBe(true);
    expectDateMatchesServedContracts(db);
    expect(pending(db)).toBe(1);
  });

  it.each([
    // Right after `contracts`: the new contract is served, and its date with it.
    ['derive-slice:amendments'],
    // After `globals`, and in the last batch: the same.
    ['derive-slice:contract-rollup'],
    ['derive-slice:cleanup'],
  ])('a run that dies at %s serves the new contract under its date', async (step) => {
    const db = freshServedDb();
    stubTwoBuckets();
    await firstRun(db);

    await expect(
      makeWorkflow(db).run(eventFor(NEXT_TODAY), runner({ dieAt: step })),
    ).rejects.toThrow(/SQLITE_NOMEM/);
    const after = served(db);
    expect(after).toMatchObject({
      asOf: NEXT_CONTRACT_DATE,
      newestContract: NEXT_CONTRACT_DATE,
      contracts: 3,
    });
    expect(after.generation > STAMP).toBe(true);
    expectDateMatchesServedContracts(db);
    // The window stays owed, so the next run derives it again.
    expect(pending(db)).toBe(1);
  });

  it('the planner watermark is not what the site shows: it may lag after a death, and the window is replayed anyway', async () => {
    const db = freshServedDb();
    stubTwoBuckets();
    await firstRun(db);

    await expect(
      makeWorkflow(db).run(eventFor(NEXT_TODAY), runner({ dieAt: 'derive-slice:amendments' })),
    ).rejects.toThrow(/SQLITE_NOMEM/);
    // data_freshness is rewritten in `globals`; before it, the planner still reads the previous day.
    expect(plannerAsOf(db)).toBe(CONTRACT_DATE);
    expect(served(db).asOf).toBe(NEXT_CONTRACT_DATE);

    pinGeneration(db);
    const replay = await makeWorkflow(db).run(eventFor(NEXT_TODAY, 'replay'), fakeStep);
    expect(replay).toMatchObject({ integrity: 'ok', uncoveredWindows: 0 });
    expect(plannerAsOf(db)).toBe(NEXT_CONTRACT_DATE);
    const after = served(db);
    expect(after).toMatchObject({ asOf: NEXT_CONTRACT_DATE, contracts: 3 });
    expect(after.generation > STAMP).toBe(true);
    expectDateMatchesServedContracts(db);
    expect(pending(db)).toBe(0);
  });

  it('a gate violation keeps the date and the generation with the served contracts; the window stays owed and the verdict says so', async () => {
    const db = freshServedDb();
    stubTwoBuckets();
    await firstRun(db);

    // A real violation from the real gate: the home total no longer reconciles with the contracts.
    const result = await makeWorkflow(db).run(
      eventFor(NEXT_TODAY),
      runner({
        after: {
          'derive-slice:cleanup': () =>
            db.exec('UPDATE home_totals SET value_eur = value_eur + 1000 WHERE id = 1'),
        },
      }),
    );
    expect(result.integrity).toBe('violation');
    expect(result.uncoveredWindows).toBeNull();
    const after = served(db);
    expect(after).toMatchObject({ asOf: NEXT_CONTRACT_DATE, contracts: 3 });
    expect(after.generation > STAMP).toBe(true);
    expectDateMatchesServedContracts(db);
    expect(pending(db)).toBe(1);
    expect(verdict(db)?.verdict).toBe('violation');
    expect(JSON.parse(verdict(db)!.checks)).toContain('rollup-reconciliation');
  });

  it('an unverified gate keeps the date and the generation with the served contracts; the window stays owed and the verdict says so', async () => {
    const db = freshServedDb();
    stubTwoBuckets();
    await firstRun(db);

    const result = await makeWorkflow(db).run(
      eventFor(NEXT_TODAY),
      runner({ dieAt: 'integrity-gate' }),
    );
    expect(result.integrity).toBe('unverified');
    expect(result.uncoveredWindows).toBeNull();
    const after = served(db);
    expect(after).toMatchObject({ asOf: NEXT_CONTRACT_DATE, contracts: 3 });
    expect(after.generation > STAMP).toBe(true);
    expectDateMatchesServedContracts(db);
    expect(pending(db)).toBe(1);
    expect(verdict(db)?.verdict).toBe('unverified');
  });

  it('a replayed `contracts` batch moves nothing a second time', async () => {
    const db = freshServedDb();
    stubTwoBuckets();
    await firstRun(db);

    // The batch commits, its step result is lost, and the step runs again: the second pass must find
    // nothing to move — not the date, not the generation, not the rows.
    const LATER = '2026-07-13 00:31:00';
    let once: ReturnType<typeof served> | undefined;
    let again: ReturnType<typeof served> | undefined;
    const replaying: WorkflowStep = {
      async do<T>(
        name: string,
        configOrCallback: Record<string, unknown> | (() => Promise<T>),
        maybeCallback?: () => Promise<T>,
      ): Promise<T> {
        const callback =
          typeof configOrCallback === 'function'
            ? configOrCallback
            : (maybeCallback as () => Promise<T>);
        if (name !== 'derive-slice:contracts') return callback();
        await callback();
        pinGeneration(db, LATER);
        once = served(db);
        const result = await callback();
        again = served(db);
        return result;
      },
    } as WorkflowStep;
    const result = await makeWorkflow(db).run(eventFor(NEXT_TODAY), replaying);
    expect(result.integrity).toBe('ok');
    expect(once).toEqual({
      asOf: NEXT_CONTRACT_DATE,
      generation: LATER,
      newestContract: NEXT_CONTRACT_DATE,
      contracts: 3,
    });
    expect(again).toEqual(once);
    // The run went on and moved the generation after its last batch.
    expect(served(db).generation > LATER).toBe(true);
    expectDateMatchesServedContracts(db);
  });

  it('moves the generation again after the batches that still write served rows past `globals`', async () => {
    const db = freshServedDb();
    stubTwoBuckets();
    await firstRun(db);

    // A page rendered right after `globals` would carry this generation; `contract-rollup` and
    // `cohort-stats` still change what it shows, so the finished run must not leave it current.
    const AFTER_GLOBALS = '2026-07-13 00:31:00';
    const result = await makeWorkflow(db).run(
      eventFor(NEXT_TODAY),
      runner({ after: { 'derive-slice:globals': () => pinGeneration(db, AFTER_GLOBALS) } }),
    );
    expect(result.integrity).toBe('ok');
    expect(served(db).generation > AFTER_GLOBALS).toBe(true);
  });

  it('a run with nothing to do moves neither the date nor the generation', async () => {
    const db = freshServedDb();
    stubTwoBuckets();
    await firstRun(db);
    const next = await makeWorkflow(db).run(eventFor(NEXT_TODAY), fakeStep);
    expect(next.integrity).toBe('ok');
    pinGeneration(db);

    const quiet = await makeWorkflow(db).run(eventFor('2026-08-15'), fakeStep);
    expect(quiet).toMatchObject({ staged: 0, derived: 0, uncoveredWindows: 0 });
    expect(served(db)).toMatchObject({ asOf: NEXT_CONTRACT_DATE, generation: STAMP, contracts: 3 });
    expectDateMatchesServedContracts(db);
  });
});
