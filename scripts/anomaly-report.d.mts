// Type surface for the per-refresh anomaly report (#100). The implementation is plain ESM (.mjs) so
// import.mjs can run it directly under `node`; this gives the TypeScript test real types.

export type AnomalyRunner = (sql: string) => Array<Record<string, unknown>>;

export interface AnomalyOptions {
  minCohort?: number;
  cohortFactor?: number;
  decimalRescaleMax?: number;
  topExamples?: number;
}

export interface CohortStat {
  count: number;
  median: number;
  p95: number;
}

export interface OutlierExample {
  id: string;
  division: string;
  amountEur: number;
  cohortP95?: number;
  ratio?: number;
  cohortMedian?: number;
  rescaledBy?: number;
}

/** What the two detector functions actually return: totals + all hit ids + bounded examples. */
export interface DetectorResult {
  total: number;
  ids: string[];
  examples: OutlierExample[];
}

export interface Finding {
  key: string;
  label: string;
  total: number;
  examples: OutlierExample[];
}

export interface AnomalyReport {
  sampled: number;
  total: number;
  findings: Finding[];
}

export const ANOMALY_DEFAULTS: Required<AnomalyOptions>;

export function percentile(values: number[], q: number): number;
export function percentileExcluding(sorted: number[], excludeIndex: number, q: number): number;
export function cohortStats(
  rows: Array<{ division: string; amountEur: number }>,
): Map<string, CohortStat>;
export function cpvCohortOutliers(
  rows: Array<{ id: string; division: string; amountEur: number }>,
  opts?: AnomalyOptions,
): DetectorResult;
export function decimalShiftSuspects(
  rows: Array<{ id: string; division: string; amountEur: number }>,
  opts?: AnomalyOptions,
): DetectorResult;
export function buildAnomalyReport(runner: AnomalyRunner, opts?: AnomalyOptions): AnomalyReport;
export function formatAnomalyReport(report: AnomalyReport): string;
