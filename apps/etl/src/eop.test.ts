import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeD1 } from '@sigma/test-support';

// Keep the pure catch-up-window helpers real (computeWorkerCatchupPlan relies on them), but stub the
// bucket-key classifier, the OCDS/base record mappers, and every staging writer so the tests drive
// eop.ts's fetch/parse/stage orchestration against a controllable fetch, with no real D1 or ingest SQL.
vi.mock('@sigma/ingest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sigma/ingest')>();
  return {
    ...actual,
    classifyBucketKey: (key: string) =>
      key.includes('ocds')
        ? 'ocds'
        : key.includes('contract')
          ? 'contracts'
          : key.includes('tender')
            ? 'tenders'
            : key.includes('annex')
              ? 'annexes'
              : null,
    releaseToContracts: () => [{ id: 'c' }],
    releaseToAmendments: () => [{ id: 'a' }],
    releaseToParties: () => [{ id: 'p' }],
    releaseToLots: () => [{ id: 'l' }],
    mapBaseRecord: (kind: string, rec: Record<string, unknown>) =>
      rec.skip ? null : { kind, ...rec },
    upsertContractStaging: vi.fn(async () => {}),
    upsertAmendmentStaging: vi.fn(async () => {}),
    upsertPartyStaging: vi.fn(async () => {}),
    upsertLotStaging: vi.fn(async () => {}),
    upsertBaseContractStaging: vi.fn(
      async (_db: unknown, _src: string, rows: unknown[]) => rows.length,
    ),
    upsertBaseTenderStaging: vi.fn(
      async (_db: unknown, _src: string, rows: unknown[]) => rows.length,
    ),
    upsertBaseAmendmentStaging: vi.fn(
      async (_db: unknown, _src: string, rows: unknown[]) => rows.length,
    ),
  };
});

import {
  computeWorkerCatchupPlan,
  ingestBucketWindow,
  listBucketForDay,
  parseBucketKeys,
  stageBaseFromBucket,
  stageOcdsFromBucket,
  type BucketListing,
} from './eop';

/**
 * A response whose stream is deliberately left open, so `cancel()` on the underlying source really
 * fires. A stream that is enqueued *and closed* would report success without proving anything: the
 * spec short-circuits `cancel()` once a stream is already closed.
 */
function openBodyResponse(init: ResponseInit & { url?: string }): {
  response: Response;
  cancelled: () => boolean;
} {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('<ListBucketResult />'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(body, init);
  if (init.url) Object.defineProperty(response, 'url', { value: init.url });
  return { response, cancelled: () => cancelled };
}

// A double with no routes at all: every one of these tests stubs the staging writers, so nothing
// may reach D1. Any query that does hits the unmatched-route throw instead of a silent empty answer.
const fakeDb = fakeD1([]).db;

// A fetch stub that dispatches on the request URL. `text` responses serve bucket XML; `json` responses
// serve object payloads. `url: ''` means no redirect, so assertAllowedFinalHost falls back to the
// request host and passes.
function stubFetch(
  handler: (url: string) => { status?: number; body?: string; finalUrl?: string },
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const { status = 200, body = '', finalUrl = '' } = handler(url);
      const res = new Response(body, { status });
      Object.defineProperty(res, 'url', { value: finalUrl });
      return res;
    }) as unknown as typeof fetch,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeDbFromFreshness(maxLoadedDate: string | null): D1Database {
  // Data-integrity invariant: the catch-up planner must derive the max-loaded date from served
  // freshness (data_freshness), never from raw staging (raw_*). data_freshness is the ONLY route, so
  // a regression that reads raw staging for planning throws rather than passing silently.
  return fakeD1([{ when: 'data_freshness', first: { max_loaded_date: maxLoadedDate } }]).db;
}

describe('parseBucketKeys', () => {
  it('extracts and XML-decodes every <Key> entry', () => {
    const xml = '<Key>a&amp;b/ocds.json</Key><Key>c&lt;d&gt;&quot;&apos;</Key>';
    expect(parseBucketKeys(xml)).toEqual(['a&b/ocds.json', 'c<d>"\'']);
  });

  it('returns an empty list when there are no keys', () => {
    expect(parseBucketKeys('<ListBucketResult />')).toEqual([]);
  });
});

describe('computeWorkerCatchupPlan', () => {
  it('plans an uncapped window straight from served freshness', async () => {
    const plan = await computeWorkerCatchupPlan(fakeDbFromFreshness('2026-06-01'), {
      today: '2026-06-07',
      lookbackDays: 3,
      maxWindowDays: 21,
    });
    expect(plan).toMatchObject({ from: '2026-05-29', to: '2026-06-07', capped: false });
    expect(plan.maxLoadedDate).toBe('2026-06-01');
  });

  it('caps an over-wide window to the most recent maxWindowDays and flags it', async () => {
    const plan = await computeWorkerCatchupPlan(fakeDbFromFreshness('2026-01-01'), {
      today: '2026-06-07',
      lookbackDays: 3,
      maxWindowDays: 5,
    });
    expect(plan.capped).toBe(true);
    expect(plan.from).toBe('2026-06-03'); // today − (5 − 1)
    expect(plan.to).toBe('2026-06-07');
    expect(plan.originalGapDays).toBeGreaterThan(5);
    expect(plan.originalFrom).not.toBe(plan.from);
  });

  it('replays an unfinished earlier window by folding its from into the plan', async () => {
    const plan = await computeWorkerCatchupPlan(fakeDbFromFreshness('2026-06-05'), {
      today: '2026-06-07',
      lookbackDays: 1,
      replay: [{ from: '2026-05-30', to: '2026-06-01' }],
    });
    // own window would be 06-04..06-07; the unfinished 05-30 wins at the start, own today at the end
    expect(plan).toMatchObject({
      from: '2026-05-30',
      to: '2026-06-07',
      capped: false,
      replayFrom: '2026-05-30',
    });
    expect(plan.originalFrom).toBe('2026-05-30');
  });

  it('keeps a backdated manual run on its own end: a promise tail past it stays outstanding', async () => {
    const plan = await computeWorkerCatchupPlan(fakeDbFromFreshness('2026-06-05'), {
      today: '2026-06-03', // an operator replaying the past
      lookbackDays: 1,
      replay: [{ from: '2026-05-30', to: '2026-06-06' }],
    });
    expect(plan.from).toBe('2026-05-30');
    expect(plan.to).toBe('2026-06-03'); // not 06-06: the tail is settled by whichever run covers it
  });

  it('never lets a later promise plus the cap displace a backdated manual window', async () => {
    const plan = await computeWorkerCatchupPlan(fakeDbFromFreshness('2026-04-08'), {
      today: '2026-04-10',
      lookbackDays: 3,
      maxWindowDays: 21,
      replay: [{ from: '2026-08-01', to: '2026-08-31' }], // recorded by a later run that died
    });
    // the operator's window, untouched: the promise lies after it and is not this run's to cover
    expect(plan).toMatchObject({ from: '2026-04-05', to: '2026-04-10', capped: false });
  });

  it('clamps a future manual today to the real calendar day without inverting the window', async () => {
    const realToday = new Date().toISOString().slice(0, 10);
    const plan = await computeWorkerCatchupPlan(fakeDbFromFreshness('2999-01-01'), {
      today: '2999-01-10', // a bogus future today: freshness and lookback both in the future
      lookbackDays: 1,
      maxWindowDays: 5,
    });
    expect(plan.to).toBe(realToday);
    expect(plan.from <= plan.to).toBe(true);
  });

  it('ignores an unfinished from that is not earlier than its own', async () => {
    const plan = await computeWorkerCatchupPlan(fakeDbFromFreshness('2026-06-05'), {
      today: '2026-06-07',
      lookbackDays: 3,
      replay: [{ from: '2026-06-06', to: '2026-06-07' }],
    });
    expect(plan.from).toBe('2026-06-02');
    expect(plan.replayFrom).toBe('2026-06-06'); // reported, not applied
  });

  it('caps a replay wider than the Worker may cover, keeping the uncapped start as originalFrom', async () => {
    const plan = await computeWorkerCatchupPlan(fakeDbFromFreshness('2026-06-05'), {
      today: '2026-06-07',
      lookbackDays: 1,
      maxWindowDays: 5,
      replay: [{ from: '2026-01-01', to: '2026-01-10' }],
    });
    expect(plan.capped).toBe(true);
    expect(plan.from).toBe('2026-06-03'); // window.to − (5 − 1)
    expect(plan.to).toBe('2026-06-07');
    // the Worker records [originalFrom, from − 1] as still outstanding from these two
    expect(plan.originalFrom).toBe('2026-01-01');
  });

  it('falls back to a null max-loaded date when freshness is empty', async () => {
    const plan = await computeWorkerCatchupPlan(fakeDbFromFreshness(null), { today: '2026-06-07' });
    expect(plan.maxLoadedDate).toBeNull();
  });

  it('defaults today to the current UTC date when no override is given', async () => {
    // Pin the clock so the `opts.today ?? new Date()...` default resolves to a known date: the window
    // must end exactly on that date, not merely be date-shaped (a shape check would survive a mutation
    // to any hard-coded ISO string).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T09:30:00Z'));
    try {
      const plan = await computeWorkerCatchupPlan(fakeDbFromFreshness('2026-06-01'), {});
      expect(plan.to).toBe('2026-06-10');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('listBucketForDay', () => {
  it('returns null for a 403 or 404 bucket', async () => {
    stubFetch(() => ({ status: 404 }));
    expect(await listBucketForDay('2026-06-01')).toBeNull();
    stubFetch(() => ({ status: 403 }));
    expect(await listBucketForDay('2026-06-01')).toBeNull();
  });

  it('throws on any other non-OK status', async () => {
    stubFetch(() => ({ status: 500 }));
    await expect(listBucketForDay('2026-06-01')).rejects.toThrow(/HTTP 500/);
  });

  it('classifies keys and keeps only the first per kind', async () => {
    stubFetch(() => ({
      body:
        '<Key>x/ocds-1.json</Key><Key>x/ocds-2.json</Key>' + // second ocds ignored
        '<Key>x/contracts.json</Key><Key>x/tenders.json</Key><Key>x/annexes.json</Key>' +
        '<Key>x/readme.txt</Key>', // unclassified → dropped
    }));
    const listing = await listBucketForDay('2026-06-01', { baseUrl: 'https://storage.eop.bg' });
    expect(listing?.keys).toEqual({
      ocds: 'x/ocds-1.json',
      contracts: 'x/contracts.json',
      tenders: 'x/tenders.json',
      annexes: 'x/annexes.json',
    });
    expect(listing?.day).toBe('2026-06-01');
  });

  it('rejects a bucket listing redirected to a different final host', async () => {
    stubFetch(() => ({ finalUrl: 'https://evil.example/open-data-2026-06-01/' }));
    await expect(listBucketForDay('2026-06-01')).rejects.toThrow(
      /blocked redirected EOP fetch from storage\.eop\.bg to evil\.example/,
    );
  });
});

const listingWith = (keys: BucketListing['keys']): BucketListing => ({
  day: '2026-06-01',
  bucketUrl: 'https://storage.eop.bg/open-data-2026-06-01/',
  keys,
});

describe('stageOcdsFromBucket', () => {
  it('stages empty tables and reports zeros when there is no OCDS key', async () => {
    const counts = await stageOcdsFromBucket(fakeDb, listingWith({}), '2026-06-01T00:00:00Z');
    expect(counts).toEqual({ ocdsContracts: 0, ocdsAmendments: 0, parties: 0, lots: 0 });
  });

  it('maps releases from a plain OCDS package', async () => {
    stubFetch(() => ({ body: JSON.stringify({ releases: [{}], publishedDate: '2026-06-01' }) }));
    const counts = await stageOcdsFromBucket(
      fakeDb,
      listingWith({ ocds: 'x/ocds.json' }),
      '2026-06-01T00:00:00Z',
    );
    expect(counts).toEqual({ ocdsContracts: 1, ocdsAmendments: 1, parties: 1, lots: 1 });
  });

  it('unwraps a { data: { releases } } envelope too', async () => {
    stubFetch(() => ({
      body: JSON.stringify({ data: { releases: [{}], publishedDate: '2026-06-02' } }),
    }));
    const counts = await stageOcdsFromBucket(
      fakeDb,
      listingWith({ ocds: 'x/ocds.json' }),
      '2026-06-01T00:00:00Z',
    );
    expect(counts.ocdsContracts).toBe(1);
  });

  it('tolerates a package with neither releases nor data', async () => {
    stubFetch(() => ({ body: JSON.stringify({ something: 'else' }) }));
    const counts = await stageOcdsFromBucket(
      fakeDb,
      listingWith({ ocds: 'x/ocds.json' }),
      '2026-06-01T00:00:00Z',
    );
    expect(counts).toEqual({ ocdsContracts: 0, ocdsAmendments: 0, parties: 0, lots: 0 });
  });

  it('throws when the OCDS object fetch is not OK', async () => {
    stubFetch(() => ({ status: 500 }));
    await expect(
      stageOcdsFromBucket(fakeDb, listingWith({ ocds: 'x/ocds.json' }), '2026-06-01T00:00:00Z'),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe('stageBaseFromBucket', () => {
  it('maps and counts base contracts, tenders, and annexes, dropping skipped records', async () => {
    stubFetch((url) => {
      if (url.includes('contracts')) return { body: JSON.stringify([{ a: 1 }, { skip: true }]) };
      if (url.includes('tenders')) return { body: JSON.stringify([{ b: 1 }]) };
      if (url.includes('annexes')) return { body: JSON.stringify([{ c: 1 }, { c: 2 }]) };
      return { body: '[]' };
    });
    const counts = await stageBaseFromBucket(
      fakeDb,
      listingWith({
        contracts: 'contracts.json',
        tenders: 'tenders.json',
        annexes: 'annexes.json',
      }),
      '2026-06-01T00:00:00Z',
    );
    expect(counts).toEqual({ baseContracts: 1, baseTenders: 1, baseAmendments: 2 });
  });

  it('reports zeros when the bucket carries no base keys', async () => {
    const counts = await stageBaseFromBucket(fakeDb, listingWith({}), '2026-06-01T00:00:00Z');
    expect(counts).toEqual({ baseContracts: 0, baseTenders: 0, baseAmendments: 0 });
  });

  it('throws when an object payload is not a JSON array', async () => {
    stubFetch(() => ({ body: JSON.stringify({ not: 'an array' }) }));
    await expect(
      stageBaseFromBucket(
        fakeDb,
        listingWith({ contracts: 'contracts.json' }),
        '2026-06-01T00:00:00Z',
      ),
    ).rejects.toThrow(/is not an array/);
  });
});

describe('ingestBucketWindow', () => {
  it('walks each day, recording a not-found day and staging a found day', async () => {
    // Day 1 (2026-06-01) → 404 (missing). Day 2 (2026-06-02) → a bucket with an OCDS + contracts key.
    stubFetch((url) => {
      if (url.includes('open-data-2026-06-01')) return { status: 404 };
      if (url.includes('open-data-2026-06-02/')) {
        // the bucket listing itself
        if (url.endsWith('open-data-2026-06-02/'))
          return { body: '<Key>2026-06-02/ocds.json</Key><Key>2026-06-02/contracts.json</Key>' };
        if (url.includes('contracts.json')) return { body: JSON.stringify([{ a: 1 }]) };
        if (url.includes('ocds.json')) return { body: JSON.stringify({ releases: [{}] }) };
      }
      return { body: '[]' };
    });
    const results = await ingestBucketWindow(
      fakeDb,
      { from: '2026-06-01', to: '2026-06-02' },
      { fetchedAt: '2026-06-02T00:00:00Z' },
    );
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ day: '2026-06-01', found: false, baseContracts: 0 });
    expect(results[1]).toMatchObject({
      day: '2026-06-02',
      found: true,
      baseContracts: 1,
      ocdsContracts: 1,
    });
  });

  it('defaults fetchedAt to now when the caller omits it', async () => {
    stubFetch(() => ({ status: 404 })); // single missing day → no staging, just the default fetchedAt
    const results = await ingestBucketWindow(fakeDb, { from: '2026-06-01', to: '2026-06-01' });
    expect(results).toEqual([expect.objectContaining({ day: '2026-06-01', found: false })]);
  });
});

describe('EOP responses the ingest walks away from', () => {
  // No local afterEach: the file-level one above already unstubs globals after every test.
  it('releases the body of a missing bucket instead of leaving the stream open', async () => {
    const { response, cancelled } = openBodyResponse({ status: 403 });
    vi.stubGlobal('fetch', vi.fn(async () => response) as unknown as typeof fetch);

    await expect(listBucketForDay('2026-06-01')).resolves.toBeNull();
    expect(cancelled()).toBe(true);
  });

  it('releases the body of a failed bucket listing before throwing', async () => {
    const { response, cancelled } = openBodyResponse({ status: 500 });
    vi.stubGlobal('fetch', vi.fn(async () => response) as unknown as typeof fetch);

    await expect(listBucketForDay('2026-06-01')).rejects.toThrow(/bucket 2026-06-01: HTTP 500/);
    expect(cancelled()).toBe(true);
  });

  it('releases the body of a blocked redirect before throwing', async () => {
    const { response, cancelled } = openBodyResponse({
      status: 200,
      url: 'https://evil.example/open-data-2026-06-01/',
    });
    vi.stubGlobal('fetch', vi.fn(async () => response) as unknown as typeof fetch);

    await expect(listBucketForDay('2026-06-01')).rejects.toThrow(/blocked redirected EOP fetch/);
    expect(cancelled()).toBe(true);
  });

  // The one drain site the first cut of this change left uncovered: bypassing it kept the whole suite
  // green. A blocked redirect on an OBJECT fetch is a different call path from the bucket listing.
  it('releases the body of a redirected object fetch before throwing', async () => {
    const { response, cancelled } = openBodyResponse({
      status: 200,
      url: 'https://evil.example/open-data-2026-06-01/contracts.json',
    });
    vi.stubGlobal('fetch', vi.fn(async () => response) as unknown as typeof fetch);

    await expect(
      stageBaseFromBucket(
        fakeD1([]).db,
        {
          day: '2026-06-01',
          bucketUrl: 'https://storage.eop.bg/open-data-2026-06-01/',
          keys: { contracts: 'contracts.json' },
        },
        '2026-06-01T00:00:00.000Z',
      ),
    ).rejects.toThrow(/blocked redirected EOP fetch from storage\.eop\.bg to evil\.example/);
    expect(cancelled()).toBe(true);
  });

  // Cancellation must be initiated, never awaited: a stream whose cancel() never settles must not be
  // able to wedge the ingest. Before this, `await res.body.cancel()` made listBucketForDay hang forever.
  it('does not wait for a cancel that never settles', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'));
      },
      cancel() {
        return new Promise<void>(() => {}); // never settles
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 403 })) as unknown as typeof fetch,
    );

    await expect(listBucketForDay('2026-06-01')).resolves.toBeNull();
  });

  it('releases the body of a failed object fetch before throwing', async () => {
    const { response, cancelled } = openBodyResponse({ status: 500 });
    vi.stubGlobal('fetch', vi.fn(async () => response) as unknown as typeof fetch);

    await expect(
      stageBaseFromBucket(
        fakeD1([]).db,
        {
          day: '2026-06-01',
          bucketUrl: 'https://storage.eop.bg/open-data-2026-06-01/',
          keys: { contracts: 'contracts.json' },
        },
        '2026-06-01T00:00:00.000Z',
      ),
    ).rejects.toThrow(/HTTP 500/);
    expect(cancelled()).toBe(true);
  });
});
