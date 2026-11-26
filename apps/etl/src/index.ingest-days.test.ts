/// <reference types="node" />
// The storage ingest runs one Workflow step per bucket day. This holds that split to the single step it
// replaced: the real RefreshWorkflow.run() and the real refresh-slice.sql on a real SQLite, a window of
// three bucket days, and storage.eop.bg mocked. The days staged step by step must leave exactly the
// staging rows the whole window staged in one pass leaves, and the served database must come out the
// same whether a middle day's step ran once, failed half-way and was retried, or ran twice.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTransientStaging } from '@sigma/ingest';
import { d1FromSqlite } from '@sigma/test-support';
import { ingestBucketDay, windowDays } from './eop';
import { RefreshWorkflow, type Env } from './index';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = resolve(root, 'packages/db/migrations');
const stagingSchemaSql = readFileSync(resolve(root, 'scripts/work-staging-schema.sql'), 'utf8');

const TODAY = '2026-07-10';
// The planner's window for an empty database: today minus the three-day lookback, to today.
const WINDOW = { from: '2026-07-07', to: TODAY };
const DAYS = ['2026-07-07', '2026-07-08', '2026-07-09'];
const MIDDLE = 'ingest-storage-eop-bucket:2026-07-08';
const NOW = new Date(`${TODAY}T06:30:00.000Z`);

function freshServedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(migrationsDir).sort()) {
    if (file.endsWith('.sql')) db.exec(readFileSync(resolve(migrationsDir, file), 'utf8'));
  }
  return db;
}

// One contract a day from the base feed, and one from the OCDS package, all invented.
const contractsFor = (day: string, n: number) => [
  {
    noticeId: `DOC-DAY-${n}`,
    publicationDate: day,
    uniqueProcurementNumber: `UNP-DAY-${n}`,
    tenderId: `TENDER-DAY-${n}`,
    procedureType: 'open',
    tenderName: `Тестова поръчка ${n}`,
    typeOfContract: 'services',
    buyerName: 'Община Тест',
    buyerRegistryNumber: '000000001',
    buyerType: 'public',
    lotIdentifier: '1',
    contractNumber: `CONTRACT-DAY-${n}`,
    contractDate: day,
    contractValue: String(1000 * n),
    contractCurrency: 'BGN',
    contractSubject: `Тестов договор ${n}`,
    supplierRegisterNumber: `00000001${n}`,
    supplierName: `ТЕСТ ГРУП ${n} ЕООД`,
    supplierNationality: 'BG',
    offersCount: String(n),
  },
];
const ocdsFor = (day: string, n: number) => ({
  publishedDate: `${day}T12:00:00Z`,
  releases: [
    {
      ocid: `ocds-test-${n}`,
      id: `ocds-test-${n}-contract`,
      date: `${day}T12:00:00Z`,
      tag: ['contract'],
      buyer: { id: 'BG-000000002', name: 'Община Проба' },
      parties: [
        {
          id: 'BG-000000002',
          name: 'Община Проба',
          roles: ['buyer'],
          identifier: { id: '000000002' },
        },
        {
          id: `BG-00000002${n}`,
          name: `ПРОБА ${n} ООД`,
          roles: ['supplier'],
          identifier: { id: `00000002${n}` },
        },
      ],
      tender: { id: `ocds-tender-${n}`, title: `Проба ${n}`, procurementMethod: 'open' },
      awards: [{ id: `award-${n}`, suppliers: [{ id: `BG-00000002${n}` }] }],
      contracts: [
        {
          id: `ocds-contract-${n}`,
          awardID: `award-${n}`,
          dateSigned: `${day}T00:00:00Z`,
          value: { amount: 500 * n, currency: 'BGN' },
        },
      ],
    },
  ],
});

// storage.eop.bg for the three days (the fourth, today, has no bucket yet), and a counter of how many
// times each object was asked for — `failOnce` answers 503 to the first request for that object.
function stubStorage(failOnce: string | null = null) {
  const asked = new Map<string, number>();
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.set(url, (asked.get(url) ?? 0) + 1);
    if (failOnce && url.endsWith(encodeURIComponent(failOnce)) && asked.get(url) === 1) {
      return new Response('unavailable', { status: 503 });
    }
    const m = /^https:\/\/storage\.eop\.bg\/open-data-(\d{4}-\d{2}-\d{2})\/(.*)$/.exec(url);
    if (!m) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    const [, day, object] = m as unknown as [string, string, string];
    const n = DAYS.indexOf(day) + 1;
    if (n === 0) return new Response('no such bucket', { status: 404 });
    const keys = [`договори-${day}.json`, `OCDS-${day}.json`];
    if (object === '') {
      const contents = keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('');
      return new Response(`<ListBucketResult>${contents}</ListBucketResult>`);
    }
    const key = decodeURIComponent(object);
    if (key === keys[0]) return Response.json(contractsFor(day, n));
    if (key === keys[1]) return Response.json(ocdsFor(day, n));
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as unknown as typeof fetch);
}

const event = {
  payload: { today: TODAY },
  timestamp: NOW,
  instanceId: 'split-ingest',
} as WorkflowEvent<{ today: string }>;

const workflowOn = (db: DatabaseSync) =>
  new RefreshWorkflow({} as never, {
    DB: d1FromSqlite(db) as unknown as Env['DB'],
    REFRESH: {} as Workflow,
  });

// Every staging table, whole and in insertion order — read right after the last ingest step, before
// the derive consumes it. The order is compared, the integer key itself is not: a source staged again
// takes new keys after the ones already there (as every retry of the single step did), and the derive
// reads the keys only to order rows, never as a value it stores.
function stagingRows(db: DatabaseSync): Record<string, unknown[]> {
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'raw\\_%' ESCAPE '\\' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((t) => t.name);
  return Object.fromEntries(
    tables.map((t) => {
      const key = (
        db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string; pk: number }[]
      ).find((c) => c.pk === 1 && c.type === 'INTEGER')?.name;
      const rows = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() as Record<
        string,
        unknown
      >[];
      return [t, rows.map((row) => JSON.stringify({ ...row, ...(key ? { [key]: '·' } : {}) }))];
    }),
  );
}

// Every table the refresh leaves behind, whole, except the FTS shadow tables (their content is the
// index's own) and the wall-clock stamps SQLite writes itself (`datetime('now')`, CURRENT_TIMESTAMP).
function servedRows(db: DatabaseSync): Record<string, unknown[]> {
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE 'search\\_index\\_%' ESCAPE '\\' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((t) => t.name);
  return Object.fromEntries(
    tables.map((t) => [
      t,
      (db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[])
        .map((row) => {
          const { refreshed_at: _refreshed, created_at: _created, ...rest } = row;
          return JSON.stringify(rest);
        })
        .sort(),
    ]),
  );
}

type Body<T> = () => Promise<T>;
const bodyOf = <T>(a: Record<string, unknown> | Body<T>, b?: Body<T>): Body<T> =>
  typeof a === 'function' ? a : (b as Body<T>);

// A step runner like the platform's: a step whose body throws is run again (the retry), up to three
// attempts. `twice` names a step whose body completes and then runs once more — the platform lost
// the result and replays the step. The staging is read when the step after the ingest starts.
function runner(opts: { twice?: string } = {}) {
  const names: string[] = [];
  let staged: Record<string, unknown[]> | null = null;
  const step = (db: DatabaseSync) =>
    ({
      async do<T>(
        name: string,
        configOrCallback: Record<string, unknown> | Body<T>,
        maybeCallback?: Body<T>,
      ): Promise<T> {
        if (name === 'pending-touched') staged = stagingRows(db);
        const body = bodyOf(configOrCallback, maybeCallback);
        for (let attempt = 1; ; attempt++) {
          names.push(name);
          try {
            if (name === opts.twice) await body();
            return await body();
          } catch (err) {
            if (attempt === 3) throw err;
          }
        }
      },
    }) as WorkflowStep;
  return { step, names, staged: () => staged };
}

async function refresh(failOnce: string | null, opts: { twice?: string } = {}) {
  const db = freshServedDb();
  stubStorage(failOnce);
  const run = runner(opts);
  const result = await workflowOn(db).run(event, run.step(db));
  return { db, result, names: run.names, staged: run.staged()! };
}

beforeEach(() => {
  // One clock for every run, so the stamps the Worker writes (fetched_at, the lease, the verdict) agree.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('RefreshWorkflow — the storage ingest, one step per bucket day', () => {
  it('stages the window day by day, each day in its own step, oldest first', async () => {
    const { names, result } = await refresh(null);

    expect(names.filter((n) => n.startsWith('ingest-storage-eop-bucket'))).toEqual(
      windowDays(WINDOW).map((day) => `ingest-storage-eop-bucket:${day}`),
    );
    expect(result).toMatchObject({ from: WINDOW.from, to: WINDOW.to, days: 4 });
    expect(result.integrity).toBe('ok');
  });

  it('leaves the staging rows the whole window staged in one pass leaves', async () => {
    const { staged, result } = await refresh(null);

    // The single step's body, verbatim: every day of the window, one after another, in one go.
    const db = freshServedDb();
    const d1 = d1FromSqlite(db) as unknown as Env['DB'];
    await createTransientStaging(d1, stagingSchemaSql);
    stubStorage();
    const onePass = [];
    for (const day of windowDays(WINDOW)) {
      onePass.push(await ingestBucketDay(d1, day, { fetchedAt: NOW.toISOString() }));
    }

    expect(staged).toEqual(stagingRows(db));
    // Base and OCDS rows both, from all three buckets: the comparison is not of empty tables.
    expect(onePass.filter((d) => d.found)).toHaveLength(3);
    expect(onePass.every((d) => !d.found || (d.baseContracts === 1 && d.ocdsContracts === 1))).toBe(
      true,
    );
    expect(result.staged).toBe(
      onePass.reduce(
        (n, d) =>
          n +
          d.baseContracts +
          d.baseTenders +
          d.baseAmendments +
          d.ocdsContracts +
          d.ocdsAmendments +
          d.parties +
          d.lots,
        0,
      ),
    );
  });

  it('a middle day that fails after staging half of its bucket is retried alone, to the same rows', async () => {
    const clean = await refresh(null);
    // The 07-08 OCDS package answers 503 once: its base contracts are staged by then.
    const retried = await refresh('OCDS-2026-07-08.json');

    // Only that day's step ran again — the days before it were not repeated.
    expect(retried.names.filter((n) => n === MIDDLE)).toHaveLength(2);
    expect(retried.names.filter((n) => n === 'ingest-storage-eop-bucket:2026-07-07')).toHaveLength(
      1,
    );
    expect(retried.staged).toEqual(clean.staged);
    expect(retried.result).toEqual(clean.result);
    expect(servedRows(retried.db)).toEqual(servedRows(clean.db));
  });

  it('a middle day whose step is replayed after it finished stages its rows once', async () => {
    const clean = await refresh(null);
    const replayed = await refresh(null, { twice: MIDDLE });

    expect(replayed.staged).toEqual(clean.staged);
    expect(replayed.result).toEqual(clean.result);
    expect(servedRows(replayed.db)).toEqual(servedRows(clean.db));
  });
});
