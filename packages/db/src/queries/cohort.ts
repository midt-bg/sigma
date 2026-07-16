// „Подобни договори" - the contract page's CPV-cohort value benchmark. Reads the precomputed
// cpv_division_stats rollup (scripts/precompute.sql / refresh-slice.sql) with one O(1) PK read; the
// per-contract fields come from the row getContract already fetched, so there is no second scan.

import type { CohortBand, ContractCohortBenchmark, CpvCohortStats } from '@sigma/api-contract';

/**
 * Minimum priced contracts before a division cohort is shown at all - mirrors the anomaly report's
 * cohort floor (scripts/anomaly-report.mjs, ANOMALY_DEFAULTS.minCohort). The finer „top X%" bands
 * require larger cohorts still (see BAND_MIN_COHORT).
 */
export const MIN_COHORT = 12;

// A „top X%" band is only honest when the cohort has enough rows that the cut names a real fraction.
// nearest-rank pXX of N rows is the ceil(XX·N)-th smallest, so „strictly above pXX" first isolates a
// single row at exactly these sizes (top1 → the 1 largest of 100; top5 → top 2 of 40; top10 → top 2
// of 20; top25 → top 3 of 12). Below the threshold the band is not offered and we fall back coarser.
const BAND_MIN_COHORT = { top1: 100, top5: 40, top10: 20, top25: 12 } as const;

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
 * Coarse position of one value inside its CPV-division cohort. Pure. Three rules keep it from
 * over-claiming precision the shared, self-inclusive grid cannot support (review nedda76):
 *
 *  - STRICT `>` for the upper bands, so a value merely EQUAL to an anchor does not qualify. With ties
 *    (e.g. hundreds of framework contracts at one price) the anchor equals many rows; `>=` labelled
 *    them all „top 1%". Equal-to-median lands in its own `at-median` band, not „above".
 *  - DISTINCT anchors: a band is skipped unless its anchor strictly exceeds the next coarser one. In a
 *    tie-collapsed cohort (p99 = p95 = … = median) none of the fine bands fire and the value reads as
 *    at/above/below median instead of a false „top 1%".
 *  - COHORT SIZE: the finer the band, the larger the cohort it needs (BAND_MIN_COHORT) - so the single
 *    most-expensive contract in a 12-row cohort is never labelled „top 1%".
 */
export function cohortBand(amountEur: number, stats: CpvCohortStats): CohortBand {
  const n = stats.pricedContracts;
  if (n >= BAND_MIN_COHORT.top1 && stats.p99Eur > stats.p95Eur && amountEur > stats.p99Eur)
    return 'top1';
  if (n >= BAND_MIN_COHORT.top5 && stats.p95Eur > stats.p90Eur && amountEur > stats.p95Eur)
    return 'top5';
  if (n >= BAND_MIN_COHORT.top10 && stats.p90Eur > stats.p75Eur && amountEur > stats.p90Eur)
    return 'top10';
  if (n >= BAND_MIN_COHORT.top25 && stats.p75Eur > stats.medianEur && amountEur > stats.p75Eur)
    return 'top25';
  if (amountEur > stats.medianEur) return 'above-median';
  if (amountEur < stats.medianEur) {
    // Symmetric lower band, gated the same way (cohort size + distinct anchor + strict <), so the
    // single cheapest contract in a small/collapsed cohort is not falsely labelled „bottom 25%".
    if (n >= BAND_MIN_COHORT.top25 && stats.medianEur > stats.p25Eur && amountEur < stats.p25Eur)
      return 'bottom25';
    return 'below-median';
  }
  return 'at-median';
}

/**
 * The benchmark for one contract from fields getContract already has (no second read), or null when
 * no honest comparison exists: no clean value (value_flag <> 'ok' → the shown amount is an estimate,
 * not a price), no CPV division, no stats row, or a cohort below MIN_COHORT. The gate matches the
 * rollup's WHERE exactly, so a shown contract is always a member of the cohort it is compared against
 * (it is NOT leave-one-out — the UI states this). Pure except for the single stats lookup.
 */
export function contractCohort(
  amountEur: number | null,
  valueFlag: string,
  division: string,
  stats: CpvCohortStats | null,
): ContractCohortBenchmark | null {
  if (amountEur == null || amountEur <= 0 || valueFlag !== 'ok' || !division) return null;
  if (!stats || stats.pricedContracts < MIN_COHORT) return null;
  return { amountEur, band: cohortBand(amountEur, stats), stats };
}
