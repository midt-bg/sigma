import { describe, expect, it } from 'vitest';
import type { CpvCohortStats } from '@sigma/api-contract';
import { MIN_COHORT, cohortBand, getContractCohort, getCpvCohortStats } from './cohort';

const stats: CpvCohortStats = {
  division: '45',
  pricedContracts: 200,
  p25Eur: 10_000,
  medianEur: 50_000,
  p75Eur: 120_000,
  p90Eur: 400_000,
  p95Eur: 900_000,
  p99Eur: 4_000_000,
};

describe('cohortBand', () => {
  it('maps an amount onto the coarse band ladder', () => {
    expect(cohortBand(5_000_000, stats)).toBe('top1');
    expect(cohortBand(1_000_000, stats)).toBe('top5');
    expect(cohortBand(500_000, stats)).toBe('top10');
    expect(cohortBand(200_000, stats)).toBe('top25');
    expect(cohortBand(60_000, stats)).toBe('above-median');
    expect(cohortBand(20_000, stats)).toBe('below-median');
    expect(cohortBand(500, stats)).toBe('bottom25');
  });

  it('treats breakpoints inclusively from the top down', () => {
    expect(cohortBand(stats.p99Eur, stats)).toBe('top1');
    expect(cohortBand(stats.p95Eur, stats)).toBe('top5');
    expect(cohortBand(stats.medianEur, stats)).toBe('above-median');
    expect(cohortBand(stats.p25Eur, stats)).toBe('below-median');
  });
});

interface FakeRow {
  contract?: { amount_eur: number | null; value_flag: string; division: string } | null;
  stats?: Partial<CpvCohortStats> | null;
}

function fakeDb({ contract = null, stats: statsOverride = null }: FakeRow): D1Database {
  const statsRow =
    statsOverride === null
      ? null
      : {
          division: statsOverride.division ?? '45',
          priced_contracts: statsOverride.pricedContracts ?? 200,
          p25_eur: statsOverride.p25Eur ?? 10_000,
          median_eur: statsOverride.medianEur ?? 50_000,
          p75_eur: statsOverride.p75Eur ?? 120_000,
          p90_eur: statsOverride.p90Eur ?? 400_000,
          p95_eur: statsOverride.p95Eur ?? 900_000,
          p99_eur: statsOverride.p99Eur ?? 4_000_000,
        };
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async first<T>() {
          return (sql.includes('cpv_division_stats') ? statsRow : contract) as T;
        },
      };
    },
  } as D1Database;
}

describe('getCpvCohortStats', () => {
  it('maps the rollup row to the DTO', async () => {
    const s = await getCpvCohortStats(fakeDb({ stats: {} }), '45');
    expect(s).toEqual(stats);
  });
  it('returns null for a division without a rollup row', async () => {
    expect(await getCpvCohortStats(fakeDb({}), '99')).toBeNull();
  });
});

describe('getContractCohort', () => {
  const cleanContract = { amount_eur: 1_000_000, value_flag: 'ok', division: '45' };

  it('returns the benchmark for a clean-value contract in a big-enough cohort', async () => {
    const b = await getContractCohort(fakeDb({ contract: cleanContract, stats: {} }), 'c:1');
    expect(b).not.toBeNull();
    expect(b?.amountEur).toBe(1_000_000);
    expect(b?.band).toBe('top5');
    expect(b?.stats.division).toBe('45');
  });

  it('returns null for a missing contract or a contract without CPV', async () => {
    expect(await getContractCohort(fakeDb({ stats: {} }), 'c:1')).toBeNull();
  });

  it('returns null without a clean value (suspect flag, null or zero amount)', async () => {
    for (const contract of [
      { ...cleanContract, value_flag: 'value_suspect' },
      { ...cleanContract, amount_eur: null },
      { ...cleanContract, amount_eur: 0 },
    ]) {
      expect(await getContractCohort(fakeDb({ contract, stats: {} }), 'c:1')).toBeNull();
    }
  });

  it('returns null when the cohort is smaller than MIN_COHORT', async () => {
    const db = fakeDb({ contract: cleanContract, stats: { pricedContracts: MIN_COHORT - 1 } });
    expect(await getContractCohort(db, 'c:1')).toBeNull();
  });
});
