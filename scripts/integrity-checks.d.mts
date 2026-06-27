// Type surface for the reconciliation gate (#97). The implementation is plain ESM (.mjs) because
// import.mjs / ship-domain.mjs run it directly under `node` with no build step; this declaration
// gives the TypeScript test (and any future TS consumer) real types.

/** A query runner: takes one SQL statement, returns the result rows. May be synchronous (the
 *  sqlite3/wrangler CLI orchestrators return rows directly) or asynchronous (the apps/etl Workflow
 *  runs `env.DB.prepare(sql).all()`, a Promise). The checks await the result, so both fit. */
export type IntegrityRunner = (
  sql: string,
) => Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>;

export interface IntegrityResult {
  /** stable check id, e.g. 'rollup-reconciliation' */
  name: string;
  /** true when the check passed or was skipped */
  ok: boolean;
  /** true when the check could not apply on this database (e.g. rollups not yet built) */
  skipped: boolean;
  /** true when the check found a non-fatal, reported-not-gated condition (e.g. out-of-range
   *  upstream dates) — printed as WARN, never fails the gate */
  warn?: boolean;
  /** human-readable summary or the list of violations */
  detail: string;
}

export function checkNonEmptyCorpus(runner: IntegrityRunner): Promise<IntegrityResult>;
export function checkRollupReconciliation(runner: IntegrityRunner): Promise<IntegrityResult>;
export function checkNoNegativeValues(runner: IntegrityRunner): Promise<IntegrityResult>;
export function checkEikValidity(runner: IntegrityRunner): Promise<IntegrityResult>;
export function checkDateSanity(runner: IntegrityRunner): Promise<IntegrityResult>;
export function checkStagingReconciliation(runner: IntegrityRunner): Promise<IntegrityResult>;

export const CHECKS: Array<(runner: IntegrityRunner) => Promise<IntegrityResult>>;
export function runIntegrityChecks(runner: IntegrityRunner): Promise<IntegrityResult[]>;

export interface AssertIntegrityOptions {
  /** label shown in the failure line, identifying the call site/backend */
  label?: string;
  /** true (default) → print and process.exit(1) on failure; false → throw instead (for tests) */
  exit?: boolean;
}
export function assertIntegrity(
  runner: IntegrityRunner,
  options?: AssertIntegrityOptions,
): Promise<IntegrityResult[]>;
