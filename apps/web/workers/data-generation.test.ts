import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHECK_MS,
  dataGeneration,
  forgetDataGeneration,
  generationOf,
  SETTLE_MS,
} from './data-generation';

const REFRESHED = '2026-11-19 12:02:53';
const PUBLISHED = '2026-11-19T05:39:11.972Z';
const SETTLED = Date.parse('2026-11-19T12:02:53Z') + SETTLE_MS;

// A D1 that answers the generation query with `rows`, one per read; an Error is thrown instead.
function database(rows: unknown[]) {
  const reads = { count: 0 };
  const DB = {
    prepare: () => ({
      first: async () => {
        const row = rows[Math.min(reads.count++, rows.length - 1)];
        if (row instanceof Error) throw row;
        return row;
      },
    }),
  } as unknown as D1Database;
  return { env: { DB }, reads };
}

// What the worker does with ctx.waitUntil: the read finishes behind the request.
function context() {
  const pending: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) }, pending };
}

beforeEach(forgetDataGeneration);

describe('the generation two stamps name', () => {
  it('is both stamps together, once the later of them has settled', () => {
    const stamps = { refreshed: REFRESHED, published: PUBLISHED };
    expect(generationOf(stamps, SETTLED)).toBe(`${REFRESHED}|${PUBLISHED}`);
    expect(generationOf(stamps, SETTLED - 1)).toBeNull();
  });

  it('is unknown while a fresh publication settles, however old the refresh', () => {
    const published = new Date(SETTLED).toISOString();
    expect(generationOf({ refreshed: REFRESHED, published }, SETTLED + 1)).toBeNull();
    expect(generationOf({ refreshed: REFRESHED, published }, SETTLED + SETTLE_MS)).not.toBeNull();
  });

  it('needs the refresh stamp, not the publication one', () => {
    expect(generationOf({ refreshed: REFRESHED, published: null }, SETTLED)).toBe(`${REFRESHED}|`);
    expect(generationOf({ refreshed: null, published: PUBLISHED }, SETTLED)).toBeNull();
    expect(generationOf(null, SETTLED)).toBeNull();
  });

  it('is unknown under a stamp it cannot read as a moment', () => {
    expect(generationOf({ refreshed: 'yesterday', published: null }, SETTLED)).toBeNull();
  });
});

describe('what an isolate knows of the generation', () => {
  it('is nothing on the first request, which starts the read behind itself', async () => {
    const { env, reads } = database([{ refreshed: REFRESHED, published: PUBLISHED }]);
    const { ctx, pending } = context();
    expect(dataGeneration(env, ctx, SETTLED)).toBeNull();
    await Promise.all(pending);
    expect(dataGeneration(env, ctx, SETTLED + 1)).toBe(`${REFRESHED}|${PUBLISHED}`);
    expect(reads.count).toBe(1);
  });

  it('asks the database once per interval, however many requests come', async () => {
    const { env, reads } = database([{ refreshed: REFRESHED, published: PUBLISHED }]);
    const { ctx, pending } = context();
    for (let i = 0; i < 50; i++) dataGeneration(env, ctx, SETTLED + i);
    await Promise.all(pending);
    expect(reads.count).toBe(1);
    dataGeneration(env, ctx, SETTLED + CHECK_MS);
    await Promise.all(pending);
    expect(reads.count).toBe(2);
  });

  it('keeps what it knew when a read fails, and tries again at the next interval', async () => {
    const later = '2026-11-19 18:03:10';
    const { env } = database([
      { refreshed: REFRESHED, published: PUBLISHED },
      new Error('D1 DB is overloaded'),
      { refreshed: later, published: PUBLISHED },
    ]);
    const { ctx, pending } = context();
    dataGeneration(env, ctx, SETTLED);
    await Promise.all(pending);
    dataGeneration(env, ctx, SETTLED + CHECK_MS);
    await Promise.all(pending);
    expect(dataGeneration(env, ctx, SETTLED + CHECK_MS + 1)).toBe(`${REFRESHED}|${PUBLISHED}`);
    dataGeneration(env, ctx, SETTLED + 2 * CHECK_MS);
    await Promise.all(pending);
    // The new stamp is there, and too young to vouch for anything yet.
    expect(dataGeneration(env, ctx, SETTLED + 2 * CHECK_MS + 1)).toBeNull();
    const settled = Date.parse('2026-11-19T18:03:10Z') + SETTLE_MS;
    expect(dataGeneration(env, ctx, settled)).toBe(`${later}|${PUBLISHED}`);
  });

  it('keeps what it knows when the database has no row to answer with', async () => {
    const { env } = database([{ refreshed: REFRESHED, published: PUBLISHED }, null]);
    const { ctx, pending } = context();
    dataGeneration(env, ctx, SETTLED);
    await Promise.all(pending);
    dataGeneration(env, ctx, SETTLED + CHECK_MS);
    await Promise.all(pending);
    expect(dataGeneration(env, ctx, SETTLED + CHECK_MS + 1)).toBe(`${REFRESHED}|${PUBLISHED}`);
  });

  it('knows nothing without a database, and fails no request over it', async () => {
    const { ctx, pending } = context();
    const unbound = {} as { DB: D1Database };
    expect(dataGeneration(unbound, ctx, SETTLED)).toBeNull();
    await Promise.all(pending);
    expect(dataGeneration(unbound, ctx, SETTLED + 1)).toBeNull();
  });
});
