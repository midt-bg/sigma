import { describe, expect, it } from 'vitest';
import { readonlyD1 } from './readonly-d1';

// Minimal fake D1 that records prepared/exec SQL and returns canned rows — same approach as the query
// unit tests. The wrapper only inspects SQL text, so no real engine is needed; the passthrough tests
// prove it forwards to the underlying handle unchanged.
function fakeDb(): { db: D1Database; calls: string[] } {
  const calls: string[] = [];
  const db = {
    prepare(sql: string) {
      calls.push(`prepare:${sql}`);
      return {
        bind(...args: unknown[]) {
          calls.push(`bind:${JSON.stringify(args)}`);
          return this;
        },
        async all() {
          return { results: [{ id: 'c:1' }], success: true, meta: {} };
        },
        async first() {
          return { id: 'c:1' };
        },
      };
    },
    async exec(sql: string) {
      calls.push(`exec:${sql}`);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
  return { db, calls };
}

describe('readonlyD1 — write rejection', () => {
  it('throws a read-only error when prepare() gets a write', () => {
    const { db } = fakeDb();
    expect(() => readonlyD1(db).prepare('DELETE FROM contracts')).toThrow(/read-only/i);
  });

  it('does not reach the underlying prepare() when rejecting a write (fail-closed before delegation)', () => {
    const { db, calls } = fakeDb();
    expect(() => readonlyD1(db).prepare('DROP TABLE contracts')).toThrow(/read-only/i);
    expect(calls).toEqual([]);
  });
});

describe('readonlyD1 — read passthrough', () => {
  it('delegates a SELECT to the underlying prepare with the exact SQL', () => {
    const { db, calls } = fakeDb();
    readonlyD1(db).prepare('SELECT id FROM contracts');
    expect(calls).toEqual(['prepare:SELECT id FROM contracts']);
  });

  it('returns rows identical to the unwrapped handle for .all()', async () => {
    const { db } = fakeDb();
    const rows = await readonlyD1(db).prepare('SELECT id FROM contracts').all();
    expect(rows).toEqual({ results: [{ id: 'c:1' }], success: true, meta: {} });
  });

  it('returns the row identical to the unwrapped handle for .first()', async () => {
    const { db } = fakeDb();
    const row = await readonlyD1(db).prepare('SELECT id FROM contracts').first();
    expect(row).toEqual({ id: 'c:1' });
  });

  it('passes .bind() args through to the underlying statement unchanged', () => {
    const { db, calls } = fakeDb();
    readonlyD1(db).prepare('SELECT id FROM contracts WHERE id = ?').bind('c:1');
    expect(calls).toEqual(['prepare:SELECT id FROM contracts WHERE id = ?', 'bind:["c:1"]']);
  });
});

describe('readonlyD1 — exec (multi-statement)', () => {
  it('allows a read-only multi-statement exec', async () => {
    const { db, calls } = fakeDb();
    await readonlyD1(db).exec('SELECT 1; SELECT 2;');
    expect(calls).toEqual(['exec:SELECT 1; SELECT 2;']);
  });

  it('throws when the second statement in exec writes', () => {
    const { db } = fakeDb();
    expect(() => readonlyD1(db).exec('SELECT 1; DELETE FROM contracts;')).toThrow(/read-only/i);
  });

  it('throws when the first statement in exec writes even if the second reads', () => {
    const { db } = fakeDb();
    expect(() => readonlyD1(db).exec('DELETE FROM contracts; SELECT 1;')).toThrow(/read-only/i);
  });
});

describe('readonlyD1 — disabled write-capable methods', () => {
  it('throws on batch()', () => {
    const { db } = fakeDb();
    expect(() => readonlyD1(db).batch([])).toThrow(/read-only/i);
  });

  it('throws on dump()', () => {
    const { db } = fakeDb();
    expect(() => readonlyD1(db).dump()).toThrow(/read-only/i);
  });

  it('throws on withSession()', () => {
    const { db } = fakeDb();
    expect(() => readonlyD1(db).withSession()).toThrow(/read-only/i);
  });
});
