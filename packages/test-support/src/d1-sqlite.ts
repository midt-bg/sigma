/// <reference types="node" />
// D1Database facade over node:sqlite. D1 *is* SQLite, so backing the binding with a real
// in-process database gives runtime-accurate SQL semantics (joins, window functions, date()) without
// booting workerd. Covers exactly the surface the ingest/refresh code paths use:
// prepare().bind().first()/all()/run() and batch() (batch runs inside one transaction, like D1).
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

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

export function d1FromSqlite(db: DatabaseSync): D1Database {
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
