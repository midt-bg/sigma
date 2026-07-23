/// <reference types="node" />
// Test-only D1Database facade over node:sqlite. D1 *is* SQLite, so backing the binding with a real
// in-process database gives runtime-accurate SQL semantics (joins, window functions, date()) without
// booting workerd. Covers exactly the surface the ingest/refresh code paths use:
// prepare().bind().first()/all()/run() and batch() (batch runs inside one transaction, like D1).
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

interface BoundStatement {
  __sql: string;
  __params: SQLInputValue[];
  bind(...params: SQLInputValue[]): BoundStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[]; success: true }>;
  run(): Promise<{ success: true }>;
}

export function d1FromSqlite(db: DatabaseSync): D1Database {
  const makeStatement = (sql: string, params: SQLInputValue[] = []): BoundStatement => ({
    __sql: sql,
    __params: params,
    bind: (...bound: SQLInputValue[]) => makeStatement(sql, bound),
    async first<T>(): Promise<T | null> {
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async all<T>(): Promise<{ results: T[]; success: true }> {
      return { results: db.prepare(sql).all(...params) as T[], success: true };
    },
    async run(): Promise<{ success: true }> {
      db.prepare(sql).run(...params);
      return { success: true };
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
      return statements.map(() => ({ success: true, meta: {} }));
    },
  } as unknown as D1Database;
}
