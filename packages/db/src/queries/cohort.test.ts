import { describe, expect, it } from 'vitest';
import type { CpvCohortStats } from '@sigma/api-contract';
import { MIN_COHORT, cohortBand, contractCohort, getCpvCohortStats } from './cohort';

// A large, well-separated cohort — every band is reachable here.
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

describe('cohortBand — happy path (large, separated cohort)', () => {
  it('maps an amount onto the band ladder', () => {
    expect(cohortBand(5_000_000, stats)).toBe('top1');
    expect(cohortBand(1_000_000, stats)).toBe('top5');
    expect(cohortBand(500_000, stats)).toBe('top10');
    expect(cohortBand(200_000, stats)).toBe('top25');
    expect(cohortBand(60_000, stats)).toBe('above-median');
    expect(cohortBand(20_000, stats)).toBe('below-median');
    expect(cohortBand(500, stats)).toBe('bottom25');
  });
});

// Regression for nedda76's Request-Changes findings #1–#3: the band must never over-claim precision
// the shared, self-inclusive percentile grid cannot support.
describe('cohortBand — no false precision', () => {
  it('#1 a value EQUAL to an anchor does not qualify for that top band (strict >)', () => {
    // Exactly p99 is not "top 1%" — with ties, the anchor value is shared by many rows.
    expect(cohortBand(stats.p99Eur, stats)).toBe('top5'); // > p95, but not > p99
    expect(cohortBand(stats.p95Eur, stats)).toBe('top10'); // > p90, but not > p95
    expect(cohortBand(stats.p75Eur, stats)).toBe('above-median');
  });

  it('#1 a fully tie-collapsed cohort (all one price) never yields "top 1%"', () => {
    // 200 framework contracts all at 100 000 € → every percentile equals 100 000.
    const flat: CpvCohortStats = {
      division: '45',
      pricedContracts: 200,
      p25Eur: 100_000,
      medianEur: 100_000,
      p75Eur: 100_000,
      p90Eur: 100_000,
      p95Eur: 100_000,
      p99Eur: 100_000,
    };
    // Every such contract reads as "at median", not "top 1%".
    expect(cohortBand(100_000, flat)).toBe('at-median');
  });

  it('#2 the most-expensive contract in a small cohort is NOT labelled "top 1%"', () => {
    // N = 12 is above MIN_COHORT but far below the top1/top5/top10 floors; only top25 is offered.
    const small: CpvCohortStats = { ...stats, pricedContracts: 12 };
    expect(cohortBand(9_999_999, small)).toBe('top25'); // > p75, best band a 12-row cohort earns
    const mid: CpvCohortStats = { ...stats, pricedContracts: 40 };
    expect(cohortBand(9_999_999, mid)).toBe('top5'); // 40 rows unlock top5 but not top1 (needs 100)
  });

  it('#3 the nearest-rank median value is "at-median", not "above-median"', () => {
    expect(cohortBand(stats.medianEur, stats)).toBe('at-median');
    expect(cohortBand(stats.medianEur + 1, stats)).toBe('above-median');
    expect(cohortBand(stats.medianEur - 1, stats)).toBe('below-median');
  });

  it('skips a fine band when its anchor is not strictly above the coarser one', () => {
    // p99 == p95 (a flat top): a value above them is NOT "top 1%" — the anchor does not separate the
    // band — it falls to the coarser top5 (whose p95>p90 guard still holds).
    const flatTop: CpvCohortStats = { ...stats, p95Eur: 4_000_000, p99Eur: 4_000_000 };
    expect(cohortBand(5_000_000, flatTop)).toBe('top5');
  });
});

interface FakeStats {
  stats?: Partial<CpvCohortStats> | null;
}

function fakeDb({ stats: statsOverride = null }: FakeStats): D1Database {
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
    prepare(_sql: string) {
      return {
        bind() {
          return this;
        },
        async first<T>() {
          return statsRow as T;
        },
      };
    },
  } as unknown as D1Database;
}

describe('getCpvCohortStats', () => {
  it('maps the rollup row to the DTO', async () => {
    expect(await getCpvCohortStats(fakeDb({ stats: {} }), '45')).toEqual(stats);
  });
  it('returns null for a division without a rollup row', async () => {
    expect(await getCpvCohortStats(fakeDb({}), '99')).toBeNull();
  });
});

describe('contractCohort — pure, no second contract read', () => {
  it('returns the benchmark for a clean-value contract in a big-enough cohort', () => {
    const b = contractCohort(1_000_000, 'ok', '45', stats);
    expect(b).not.toBeNull();
    expect(b?.amountEur).toBe(1_000_000);
    expect(b?.band).toBe('top5');
    expect(b?.stats.division).toBe('45');
  });

  it('returns null without a CPV division', () => {
    expect(contractCohort(1_000_000, 'ok', '', stats)).toBeNull();
  });

  it('returns null without a clean value (suspect flag, null or zero amount)', () => {
    expect(contractCohort(1_000_000, 'value_suspect', '45', stats)).toBeNull();
    expect(contractCohort(null, 'ok', '45', stats)).toBeNull();
    expect(contractCohort(0, 'ok', '45', stats)).toBeNull();
  });

  it('returns null when there are no stats or the cohort is below MIN_COHORT', () => {
    expect(contractCohort(1_000_000, 'ok', '45', null)).toBeNull();
    expect(
      contractCohort(1_000_000, 'ok', '45', { ...stats, pricedContracts: MIN_COHORT - 1 }),
    ).toBeNull();
  });
});
