/// <reference types="node" />
// D1Database facade over node:sqlite. D1 *is* SQLite, so backing the binding with a real
// in-process database gives runtime-accurate SQL semantics (joins, window functions, date()) without
// booting workerd. Covers exactly the surface the ingest/refresh code paths use:
// prepare().bind().first()/all()/run() and batch() (batch runs inside one transaction, like D1).
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';

/**
 * Every key a real `D1Result` carries. Spelling out `results` and `meta` even where a write has
 * neither keeps the facade honest: the cast to `D1Database` would otherwise hide a missing key
 * until a reader got `undefined` here and `[]` from D1.
 */
type D1Shape<T> = { results: T[]; success: true; meta: Record<string, unknown> };

interface BoundStatement {
  __sql: string;
  __params: SQLInputValue[];
  bind(...params: SQLInputValue[]): BoundStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Shape<T>>;
  run(): Promise<D1Shape<never>>;
}

// D1 caps a LIKE/GLOB pattern at 50 bytes (SQLite's default is 50 000), so a pattern built from a bound
// value passes here and fails in production with this message. Enforce the cap; matching stays SQLite's.
const PATTERN_BYTES = 50;
let reference: DatabaseSync | undefined;
function capPatterns(db: DatabaseSync): void {
  reference ??= new DatabaseSync(':memory:');
  const like = reference.prepare('SELECT ?2 LIKE ?1 AS r');
  const likeEscape = reference.prepare('SELECT ?2 LIKE ?1 ESCAPE ?3 AS r');
  const glob = reference.prepare('SELECT ?2 GLOB ?1 AS r');
  const capped =
    (match: (args: SQLOutputValue[]) => SQLOutputValue) =>
    (...args: SQLOutputValue[]) => {
      if (typeof args[0] === 'string' && Buffer.byteLength(args[0]) > PATTERN_BYTES)
        throw new Error('LIKE or GLOB pattern too complex');
      return match(args);
    };
  db.function(
    'like',
    { varargs: true, deterministic: true },
    capped((args) => (args.length > 2 ? likeEscape : like).get(...args)!.r as SQLOutputValue),
  );
  db.function(
    'glob',
    { varargs: true, deterministic: true },
    capped((args) => glob.get(...args)!.r as SQLOutputValue),
  );
}

export function d1FromSqlite(db: DatabaseSync): D1Database {
  capPatterns(db);
  const makeStatement = (sql: string, params: SQLInputValue[] = []): BoundStatement => ({
    __sql: sql,
    __params: params,
    bind: (...bound: SQLInputValue[]) => makeStatement(sql, bound),
    async first<T>(): Promise<T | null> {
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async all<T>(): Promise<D1Shape<T>> {
      return { results: db.prepare(sql).all(...params) as T[], success: true, meta: {} };
    },
    async run(): Promise<D1Shape<never>> {
      db.prepare(sql).run(...params);
      return { results: [], success: true, meta: {} };
    },
  });

  return {
    prepare: (sql: string) => makeStatement(sql),
    async batch(statements: BoundStatement[]) {
      db.exec('BEGIN');
      try {
        for (const statement of statements) {
          db.prepare(statement.__sql).run(...statement.__params);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return statements.map(() => ({ results: [], success: true, meta: {} }));
    },
  } as unknown as D1Database;
}
