import { describe, expect, it } from 'vitest';
import type { StoredReport } from '@sigma/report';
import { headers, loader, meta } from './weeks.$iso';

describe('weeks.$iso headers', () => {
  it('is NOT shared-cached, so an in-place re-issued/corrected week propagates immediately (#81)', () => {
    const cc = headers()['Cache-Control'];
    // `private` keeps shared caches (Cloudflare CDN) from holding a stale copy; the worker also skips its
    // per-colo edge cache for /weeks/:iso. No s-maxage (shared TTL) and never immutable.
    expect(cc).toContain('private');
    expect(cc).not.toContain('s-maxage');
    expect(cc).not.toContain('immutable');
  });
});

describe('weeks.$iso meta', () => {
  it('emits robots: noindex — the digest names winning bidders (possible natural persons) publicly', () => {
    const tags = meta({
      matches: [],
      data: {
        iso: '2026-W25',
        report: { title: 'Седмицата в пари', question: '', watermark: 'ai-generated', blocks: [] },
        asOf: null,
        generatedAt: '2026-06-22T07:00:00.000Z',
        refreshedAt: null,
      },
    } as unknown as Parameters<typeof meta>[0]);
    expect(tags).toContainEqual({ name: 'robots', content: 'noindex' });
  });
});

// A minimal StoredReport in the canonical @sigma/report shape (provenance carries freshness/model/sql).
const STORED = {
  schemaVersion: 1,
  id: 'r_test',
  createdAt: '2026-06-22T07:00:00.000Z',
  report: {
    title: 'Седмицата в пари: 15–21 юни 2026',
    question: 'Какво се случи през седмицата?',
    watermark: 'ai-generated',
    blocks: [{ type: 'totals', items: [{ label: 'Общо', value: 1000, format: 'money' }] }],
  },
  provenance: {
    question: 'Какво се случи през седмицата?',
    sources: [],
    snapshot: [],
    freshness: [{ source: 'd1', asOf: '2026-06-21' }],
    model: 'bggpt-gemma-3-27b-fp8',
    promptVersion: 'v1',
  },
} as unknown as StoredReport;

// D1 THROWS on any access → proves the serve path is R2-only. REPORTS returns the artifact text or null.
function makeContext(objectText: string | null) {
  const getCalls: string[] = [];
  const DB = new Proxy(
    {},
    {
      get() {
        throw new Error('D1 was accessed during /weeks serve — the serve path must be R2-only');
      },
    },
  );
  const REPORTS = {
    get: async (key: string) => {
      getCalls.push(key);
      return objectText === null ? null : { text: async () => objectText };
    },
  };
  return { context: { cloudflare: { env: { DB, REPORTS } } }, getCalls };
}

function callLoader(iso: string, objectText: string | null) {
  const { context, getCalls } = makeContext(objectText);
  const args = {
    params: { iso },
    context,
    request: new Request(`https://sigma.bg/weeks/${iso}`),
  } as unknown as Parameters<typeof loader>[0];
  return { promise: loader(args), getCalls };
}

describe('weeks.$iso loader', () => {
  it('reads the artifact from R2 and returns client-safe data without touching D1', async () => {
    const { promise, getCalls } = callLoader('2026-W25', JSON.stringify(STORED));
    const result = (await promise) as {
      iso: string;
      report: { title: string };
      asOf: string | null;
      generatedAt: string;
    };
    expect(result.iso).toBe('2026-W25');
    expect(result.report.title).toBe('Седмицата в пари: 15–21 юни 2026');
    expect(result.asOf).toBe('2026-06-21');
    expect(result.generatedAt).toBe('2026-06-22T07:00:00.000Z');
    expect(getCalls).toEqual(['weeks/2026-W25.json']);
  });

  it('does not leak provenance into the client payload', async () => {
    const { promise } = callLoader('2026-W25', JSON.stringify(STORED));
    const result = (await promise) as Record<string, unknown>;
    expect('provenance' in result).toBe(false);
  });

  it('throws 404 when the week has no artifact', async () => {
    const { promise } = callLoader('2099-W01', null);
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(404);
  });

  it('throws 404 on a malformed iso without reading R2', async () => {
    const { promise, getCalls } = callLoader('not-a-week', 'ignored');
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(404);
    expect(getCalls).toEqual([]);
  });

  it('throws 404 (not 500) on a valid-JSON-but-wrong-shape artifact', async () => {
    // A hand-written / corrupt upload that parses but lacks report.blocks / provenance.freshness must
    // 404, not 500 the page on every request (the component/meta would deref missing fields otherwise).
    const { promise } = callLoader('2026-W25', JSON.stringify({ hello: 1 }));
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(404);
  });
});
