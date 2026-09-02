import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeD1 } from '@sigma/test-support';
import { computeWorkerCatchupPlan, listBucketForDay, stageBaseFromBucket } from './eop';

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

function fakeDbFromFreshness(maxLoadedDate: string): D1Database {
  return fakeD1([
    {
      when: 'raw_contracts',
      first: () => {
        throw new Error('raw staging should not be read for planning');
      },
    },
    { when: [], first: { max_loaded_date: maxLoadedDate } },
  ]).db;
}

describe('computeWorkerCatchupPlan', () => {
  it('plans from served freshness and ignores leaked raw staging', async () => {
    const plan = await computeWorkerCatchupPlan(fakeDbFromFreshness('2026-06-01'), {
      today: '2026-06-07',
      lookbackDays: 3,
      maxWindowDays: 21,
    });

    expect(plan.from).toBe('2026-05-29');
    expect(plan.to).toBe('2026-06-07');
    expect(plan.maxLoadedDate).toBe('2026-06-01');
  });
});

describe('EOP fetch host allowlist', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects bucket listing redirects to a different final host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const response = new Response('<ListBucketResult />', { status: 200 });
        Object.defineProperty(response, 'url', {
          value: 'https://evil.example/open-data-2026-06-01/',
        });
        return response;
      }) as unknown as typeof fetch,
    );

    await expect(listBucketForDay('2026-06-01')).rejects.toThrow(
      /blocked redirected EOP fetch from storage\.eop\.bg to evil\.example/,
    );
  });
});

describe('EOP responses the ingest walks away from', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
