// „Подобни договори" - the contract page's CPV-cohort value benchmark. Reads the precomputed
// cpv_division_stats rollup (scripts/precompute.sql §4c / refresh-slice.sql), never scans the
// division per request: two indexed single-row reads per page view, D1 meters rows read.

import type { CohortBand, ContractCohortBenchmark, CpvCohortStats } from '@sigma/api-contract';

/**
 * Minimum priced contracts before a division cohort is honest enough to show - mirrors the
 * anomaly report's cohort floor (scripts/anomaly-report.mjs, ANOMALY_DEFAULTS.minCohort).
 */
export const MIN_COHORT = 12;

interface CohortStatsRow {
  division: string;
  priced_contracts: number;
  p25_eur: number;
  median_eur: number;
  p75_eur: number;
  p90_eur: number;
  p95_eur: number;
  p99_eur: number;
}

export async function getCpvCohortStats(
  db: D1Database,
  division: string,
): Promise<CpvCohortStats | null> {
  const row = await db
    .prepare(`SELECT * FROM cpv_division_stats WHERE division = ?`)
    .bind(division)
    .first<CohortStatsRow>();
  if (!row) return null;
  return {
    division: row.division,
    pricedContracts: row.priced_contracts,
    p25Eur: row.p25_eur,
    medianEur: row.median_eur,
    p75Eur: row.p75_eur,
    p90Eur: row.p90_eur,
    p95Eur: row.p95_eur,
    p99Eur: row.p99_eur,
  };
}

/**
 * Coarse display band from the precomputed grid. The cohort includes the candidate itself (the
 * rollup is shared, not leave-one-out), so bands are deliberately wide steps - never a fake-precise
 * "топ 4.7%". Pure.
 */
export function cohortBand(amountEur: number, stats: CpvCohortStats): CohortBand {
  if (amountEur >= stats.p99Eur) return 'top1';
  if (amountEur >= stats.p95Eur) return 'top5';
  if (amountEur >= stats.p90Eur) return 'top10';
  if (amountEur >= stats.p75Eur) return 'top25';
  if (amountEur >= stats.medianEur) return 'above-median';
  if (amountEur >= stats.p25Eur) return 'below-median';
  return 'bottom25';
}

/**
 * The benchmark for one contract, or null whenever an honest comparison cannot be made: no clean
 * value (value_flag <> 'ok' - the shown amount would be an estimate, not a price), no CPV, no
 * stats row, or a cohort below MIN_COHORT. The row set matches the rollup's WHERE exactly, so a
 * shown contract is always a member of the cohort it is compared against.
 */
export async function getContractCohort(
  db: D1Database,
  contractId: string,
): Promise<ContractCohortBenchmark | null> {
  const row = await db
    .prepare(
      `SELECT c.amount_eur, c.value_flag, substr(t.cpv_code, 1, 2) AS division
       FROM contracts c JOIN tenders t ON t.id = c.tender_id
       WHERE c.id = ? AND COALESCE(t.cpv_code, '') <> ''`,
    )
    .bind(contractId)
    .first<{ amount_eur: number | null; value_flag: string; division: string }>();
  if (!row || row.amount_eur == null || row.amount_eur <= 0 || row.value_flag !== 'ok') return null;
  const stats = await getCpvCohortStats(db, row.division);
  if (!stats || stats.pricedContracts < MIN_COHORT) return null;
  return { amountEur: row.amount_eur, band: cohortBand(row.amount_eur, stats), stats };
}
