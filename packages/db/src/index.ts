export * from './queries';

// Read-only D1 wrapper (issue #199): least-privilege chokepoint the web runtime uses instead of the raw
// env.DB binding, so a guard bypass on the assistant run_sql path can never reach a D1 write.
export { readonlyD1, getDb } from './readonly-d1';
export { isReadOnlySql, assertReadOnly } from './readonly-sql';
