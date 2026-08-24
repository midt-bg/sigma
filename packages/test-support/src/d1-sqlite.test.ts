/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1FromSqlite } from './d1-sqlite';

let sqlite: DatabaseSync;
let db: D1Database;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL)`);
  sqlite.exec(`INSERT INTO t (id, n) VALUES ('a', 1), ('b', 2)`);
  db = d1FromSqlite(sqlite);
});

describe('d1FromSqlite', () => {
  it('runs real SQL for all(), in the real order', async () => {
    const { results, success } = await db.prepare('SELECT id FROM t ORDER BY n DESC').all();
    expect(results).toEqual([{ id: 'b' }, { id: 'a' }]);
    expect(success).toBe(true);
  });

  it('binds parameters positionally', async () => {
    const { results } = await db.prepare('SELECT id FROM t WHERE n > ?').bind(1).all();
    expect(results).toEqual([{ id: 'b' }]);
  });

  it('returns the first row, or null when the query matches nothing', async () => {
    await expect(db.prepare('SELECT n FROM t WHERE id = ?').bind('a').first()).resolves.toEqual({
      n: 1,
    });
    await expect(db.prepare('SELECT n FROM t WHERE id = ?').bind('zz').first()).resolves.toBeNull();
  });

  it('writes through run()', async () => {
    await db.prepare('INSERT INTO t (id, n) VALUES (?, ?)').bind('c', 3).run();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 3 });
  });

  it('leaves a bound statement reusable — bind() returns a new statement, not a mutated one', async () => {
    const stmt = db.prepare('SELECT id FROM t WHERE n = ?');
    const one = await stmt.bind(1).all();
    const two = await stmt.bind(2).all();
    expect(one.results).toEqual([{ id: 'a' }]);
    expect(two.results).toEqual([{ id: 'b' }]);
  });

  it('applies every statement of a batch', async () => {
    await db.batch([
      db.prepare(`INSERT INTO t (id, n) VALUES ('c', 3)`),
      db.prepare(`INSERT INTO t (id, n) VALUES ('d', 4)`),
    ]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 4 });
  });

  it('rolls the whole batch back when one statement fails, like D1', async () => {
    // The reason batch() opens a transaction at all: a half-applied batch would leave the fixture in
    // a state no production path can produce, and the test that met it would be debugging a ghost.
    await expect(
      db.batch([
        db.prepare(`INSERT INTO t (id, n) VALUES ('c', 3)`),
        db.prepare(`INSERT INTO t (id, n) VALUES ('a', 9)`), // duplicate primary key
      ]),
    ).rejects.toThrow();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 2 });
  });

  it('carries the keys a real D1Result always has, on all(), run() and batch() alike', async () => {
    // The cast to D1Database hides a missing key: a reader gets `undefined` from the facade where
    // real D1 hands back `[]` or `{}`.
    expect(await db.prepare('SELECT id FROM t').all()).toMatchObject({ success: true, meta: {} });
    expect(await db.prepare("INSERT INTO t VALUES ('c', 3)").run()).toEqual({
      results: [],
      success: true,
      meta: {},
    });
    expect(await db.batch([db.prepare("INSERT INTO t VALUES ('d', 4)")])).toEqual([
      { results: [], success: true, meta: {} },
    ]);
  });

  it('reports one success per batched statement', async () => {
    const out = await db.batch([db.prepare(`INSERT INTO t (id, n) VALUES ('c', 3)`)]);
    expect(out).toEqual([{ results: [], success: true, meta: {} }]);
  });
});
