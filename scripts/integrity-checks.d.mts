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

/** A D1 runner waits BREATHER_MS after a query that read HEAVY_ROWS rows or more. */
export const HEAVY_ROWS: number;
export const BREATHER_MS: number;

export function checkNonEmptyCorpus(runner: IntegrityRunner): Promise<IntegrityResult>;
export function checkRollupReconciliation(runner: IntegrityRunner): Promise<IntegrityResult>;
export function checkCurrentAmountParity(runner: IntegrityRunner): Promise<IntegrityResult>;
export function checkAnnexTotalSuspectBasis(runner: IntegrityRunner): Promise<IntegrityResult>;
export function checkFrameworkCeilingsUnsummed(runner: IntegrityRunner): Promise<IntegrityResult>;
/** Build-time only: writes and empties transient staging and evaluates every contract (BUILD_CHECKS). */
export function checkContractValueRule(runner: IntegrityRunner): Promise<IntegrityResult>;
/** The checks only a local build runs (assertIntegrity `build: true`), never a served gate. */
export const BUILD_CHECKS: Array<(runner: IntegrityRunner) => Promise<IntegrityResult>>;
export function checkNoNegativeValues(runner: IntegrityRunner): Promise<IntegrityResult>;
export function checkEikValidity(runner: IntegrityRunner): Promise<IntegrityResult>;
export function checkDateSanity(runner: IntegrityRunner): Promise<IntegrityResult>;
export function checkStagingReconciliation(runner: IntegrityRunner): Promise<IntegrityResult>;
export function checkAmendmentTwins(runner: IntegrityRunner): Promise<IntegrityResult>;
export function checkOcdsSourceValue(
  runner: IntegrityRunner,
  options?: { build?: boolean },
): Promise<IntegrityResult>;
/** The OCDS eligibility and ranking CTEs shared with refresh-slice.sql. */
export const OCDS_SOURCE_VALUE_DECISION_SQL: string;
/** The ids of served OCDS amendments still keyed by their OCID that duplicate an annex served under the
 *  resolved УНП. Shared with the removal in scripts/refresh-slice.sql (lockstep-tested). */
export const AMENDMENT_OCID_TWINS_SQL: string;
/** The ids of served OCDS amendments kept under the annex-side number of an EOP annex the value resolver
 *  moved onto its contract. Shared with the removal in scripts/refresh-slice.sql (lockstep-tested). */
export const AMENDMENT_RAW_NUMBER_TWINS_SQL: string;

export const CHECKS: Array<(runner: IntegrityRunner) => Promise<IntegrityResult>>;
/** Each check's stable id, in CHECKS order (the `name` its result carries). */
export const CHECK_NAMES: string[];
export function runIntegrityChecks(
  runner: IntegrityRunner,
  options?: { build?: boolean },
): Promise<IntegrityResult[]>;

export interface IntegritySummary {
  /** true when no check is a hard failure (warnings/skips don't break the gate) */
  ok: boolean;
  violations: IntegrityResult[];
  warned: IntegrityResult[];
  ran: number;
  skipped: number;
  /** canonical failure message, or null when ok — the single source both callers report */
  message: string | null;
}

/** Reduce check results to the gate verdict + canonical message (shared by assertIntegrity and the
 *  apps/etl Worker gate, so the two never diverge). */
export function summarizeIntegrity(results: IntegrityResult[], label?: string): IntegritySummary;

export interface AssertIntegrityOptions {
  /** label shown in the failure line, identifying the call site/backend */
  label?: string;
  /** true (default) → print and process.exit(1) on failure; false → throw instead (for tests) */
  exit?: boolean;
  /** true on a local work database: require all OCDS corrections and run BUILD_CHECKS */
  build?: boolean;
}
export function assertIntegrity(
  runner: IntegrityRunner,
  options?: AssertIntegrityOptions,
): Promise<IntegrityResult[]>;
