// Decoupled StoredReport builder + R2 persistence (#167A T1) — extracted from `agent.ts`'s
// chat-coupled `persistReport` so both the chat lane (`apps/web`) and the ETL producer
// (`apps/etl`) can build/persist the same `StoredReport` shape without depending on `ToolContext`.

// Shape drift guard: mirrors the golden fixture's top-level + provenance keys
// (`apps/web/app/lib/assistant-contract/fixtures/stored-report.sample.json`, exercised by
// `assistant-contract/fixtures.test.ts` on the web side). Kept as literals here rather than a
// cross-package JSON import — `@sigma/report` must not read fixtures out of `apps/web`.
const STORED_REPORT_KEYS = ['schemaVersion', 'id', 'createdAt', 'report', 'provenance'] as const;
const PROVENANCE_KEYS = [
  'question',
  'sources',
  'snapshot',
  'freshness',
  'model',
  'promptVersion',
] as const;

import { describe, expect, it, vi } from 'vitest';
import { buildStoredReport, persistReport, readStoredReport } from './persist';
import { STORED_REPORT_SCHEMA_VERSION } from './contract';
import type { ResolvedReport } from './report-schema';

const REPORT: ResolvedReport = {
  title: 'Най-големи възложители по похарчено',
  question: 'Кои са най-големите възложители по похарчени средства?',
  watermark: 'ai-generated',
  blocks: [{ type: 'text', md: 'Първите няколко възложители формират голям дял.' }],
};

function baseInput() {
  return {
    id: 'r_test1234',
    report: REPORT,
    question: 'Кои са най-големите възложители по похарчени средства?',
    sources: [{ handle: 'R1', tool: 'run_sql', sql: 'SELECT 1' }],
    snapshot: [{ handle: 'R1', columns: ['a'], rows: [[1]] }],
    freshness: [{ source: 'admin' as const, asOf: '2026-06-18' }],
    model: 'bggpt-gemma-3-27b-fp8',
    promptVersion: 'sp_deadbeef',
  };
}

describe('buildStoredReport', () => {
  it('produces a StoredReport matching the frozen contract shape (drift guard vs the fixture)', () => {
    const stored = buildStoredReport(baseInput());

    expect(stored.schemaVersion).toBe(STORED_REPORT_SCHEMA_VERSION);
    expect(stored.id).toBe('r_test1234');
    expect(typeof stored.createdAt).toBe('string');
    expect(() => new Date(stored.createdAt).toISOString()).not.toThrow();
    expect(stored.report).toEqual(REPORT);
    expect(stored.provenance.question).toBe(baseInput().question);
    expect(stored.provenance.sources).toEqual(baseInput().sources);
    expect(stored.provenance.snapshot).toEqual(baseInput().snapshot);
    expect(stored.provenance.freshness).toEqual(baseInput().freshness);
    expect(stored.provenance.model).toBe('bggpt-gemma-3-27b-fp8');
    expect(stored.provenance.promptVersion).toBe('sp_deadbeef');
    expect(stored.provenance.verification).toBeUndefined();

    // shape parity against the golden fixture's key set (same top-level + provenance keys)
    expect(Object.keys(stored).sort()).toEqual([...STORED_REPORT_KEYS].sort());
    expect(Object.keys(stored.provenance).sort()).toEqual([...PROVENANCE_KEYS].sort());
  });

  it('accepts an explicit createdAt (deterministic tests / regen)', () => {
    const stored = buildStoredReport({ ...baseInput(), createdAt: '2026-06-21T09:30:00.000Z' });
    expect(stored.createdAt).toBe('2026-06-21T09:30:00.000Z');
  });

  it('includes verification only when supplied (additive field, absent on skip)', () => {
    const withVerification = buildStoredReport({
      ...baseInput(),
      verification: {
        status: 'verified' as const,
        strippedClaimIds: ['C1'],
        uncertainClaimIds: ['C2'],
      },
    });
    expect(withVerification.provenance.verification).toEqual({
      status: 'verified',
      strippedClaimIds: ['C1'],
      uncertainClaimIds: ['C2'],
    });

    const withError = buildStoredReport({
      ...baseInput(),
      verification: {
        status: 'error' as const,
        strippedClaimIds: [],
        uncertainClaimIds: [],
        errors: ['timeout'],
      },
    });
    expect(withError.provenance.verification).toEqual({
      status: 'error',
      strippedClaimIds: [],
      uncertainClaimIds: [],
      errors: ['timeout'],
    });

    const withoutVerification = buildStoredReport(baseInput());
    expect(withoutVerification.provenance).not.toHaveProperty('verification');
  });
});

function fakeBucket() {
  const store = new Map<string, { body: string; opts?: unknown }>();
  return {
    store,
    put: vi.fn(async (key: string, body: string, opts?: unknown) => {
      store.set(key, { body, opts });
    }),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      return { text: async () => entry.body } as { text: () => Promise<string> };
    }),
  };
}

describe('persistReport / readStoredReport', () => {
  it('writes JSON with contentType + customMetadata (title/question/createdAt)', async () => {
    const bucket = fakeBucket();
    const stored = buildStoredReport(baseInput());

    await persistReport(bucket as never, 'report/r_test1234.json', stored);

    expect(bucket.put).toHaveBeenCalledTimes(1);
    const [key, body, opts] = bucket.put.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(key).toBe('report/r_test1234.json');
    expect(JSON.parse(body)).toEqual(stored);
    expect(opts).toMatchObject({
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        title: stored.report.title,
        question: stored.provenance.question,
        createdAt: stored.createdAt,
      },
    });
  });

  it('sets cacheControl immutable only when opts.immutable is true', async () => {
    const bucket = fakeBucket();
    const stored = buildStoredReport(baseInput());

    await persistReport(bucket as never, 'weeks/2026-W28.json', stored, { immutable: true });

    const [, , opts] = bucket.put.mock.calls[0] as [string, string, Record<string, unknown>];
    expect((opts.httpMetadata as { cacheControl?: string }).cacheControl).toMatch(/immutable/);
  });

  it('merges opts.customMetadata over the base keys, and the base trio always wins', async () => {
    const bucket = fakeBucket();
    const stored = buildStoredReport(baseInput());

    await persistReport(bucket as never, 'weeks/2026-W28.json', stored, {
      customMetadata: {
        totalEur: '51600000000',
        monday: '2026-06-08',
        sunday: '2026-06-14',
        title: 'HACKED', // a caller must NOT be able to clobber the canonical title
      },
    });

    const [, , opts] = bucket.put.mock.calls[0] as [string, string, Record<string, unknown>];
    const cm = opts.customMetadata as Record<string, string>;
    expect(cm.totalEur).toBe('51600000000');
    expect(cm.monday).toBe('2026-06-08');
    expect(cm.sunday).toBe('2026-06-14');
    // Base keys are applied last, so the real title survives the collision attempt.
    expect(cm.title).toBe(stored.report.title);
    expect(cm.question).toBe(stored.provenance.question);
    expect(cm.createdAt).toBe(stored.createdAt);
  });

  it('round-trips via readStoredReport', async () => {
    const bucket = fakeBucket();
    const stored = buildStoredReport(baseInput());
    await persistReport(bucket as never, 'report/r_test1234.json', stored);

    const read = await readStoredReport(bucket as never, 'report/r_test1234.json');
    expect(read).toEqual(stored);
  });

  it('readStoredReport returns null when the key is absent', async () => {
    const bucket = fakeBucket();
    const read = await readStoredReport(bucket as never, 'report/missing.json');
    expect(read).toBeNull();
  });
});
