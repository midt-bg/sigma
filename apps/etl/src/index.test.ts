/// <reference types="node" />
// End-to-end refresh Workflow test (#158): the cron path must load FX rates before the derive so
// foreign-currency contracts get a real amount_eur instead of silently dropping out of every
// rollup. Runs the real RefreshWorkflow.run() — real staging, real refresh-slice.sql derive —
// against a real SQLite behind the D1 facade, with storage.eop.bg and api.frankfurter.app fetches
// mocked deterministically (fixed rates, no live network).
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { d1FromSqlite } from '../../../packages/ingest/src/test/d1-sqlite';
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
  '2026-07-04': { EUR: 0.86 },
  '2026-07-07': { EUR: 0.87 },
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

    if (url.startsWith('https://api.frankfurter.app/')) {
      frankfurterCalls += 1;
      const base = new URL(url).searchParams.get('base');
      if (base === 'USD') {
        return new Response(JSON.stringify({ base: 'USD', rates: USD_RATES }), { status: 200 });
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
