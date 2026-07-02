/// <reference types="node" />
// Per-refresh anomaly report (#100) — exercises the PURE detection logic with plain fixture arrays
// and an injected runner, so it runs locally with no sqlite (unlike the integrity-gate test, whose
// SQL is exercised against the sqlite3 CLI). The SQL fetch itself is trivial (SELECT only); all the
// statistics + thresholds under test live in JS here.
import { describe, expect, it } from 'vitest';
import {
  ANOMALY_DEFAULTS,
  buildAnomalyReport,
  cohortStats,
  cpvCohortOutliers,
  decimalShiftSuspects,
  formatAnomalyReport,
  percentile,
  percentileExcluding,
  type AnomalyRunner,
} from '../../../scripts/anomaly-report.mjs';

describe('percentile', () => {
  it('interpolates and clamps', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([42], 0.95)).toBe(42);
    expect(percentile([0, 10], 0.5)).toBe(5);
    expect(percentile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5);
    expect(percentile([5, 1, 4, 2, 3], 0)).toBe(1); // sorts internally
  });
});

describe('percentileExcluding', () => {
  it('matches percentile() over the array with the element removed', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 1000];
    for (let j = 0; j < sorted.length; j++) {
      const without = sorted.filter((_, k) => k !== j);
      expect(percentileExcluding(sorted, j, 0.95)).toBeCloseTo(percentile(without, 0.95));
      expect(percentileExcluding(sorted, j, 0.5)).toBeCloseTo(percentile(without, 0.5));
    }
  });

  it('handles degenerate sizes', () => {
    expect(percentileExcluding([7], 0, 0.95)).toBe(0); // nothing left
    expect(percentileExcluding([7, 9], 1, 0.95)).toBe(7); // one left
  });
});

// A realistically-sized cohort of `n` "normal" contracts TIGHTLY clustered around `base` in one CPV
// division. Real divisions hold hundreds–thousands of rows, so a couple of outliers don't move p95;
// the fixture must mirror that (a tiny cohort would let the outliers inflate their own p95 and dodge
// detection — which is exactly why minCohort exists).
function cohort(
  division: string,
  n: number,
  base: number,
): { id: string; division: string; amountEur: number }[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${division}-${i}`,
    division,
    amountEur: base + (i % 25) * (base * 0.01), // clustered in [base, base + 0.24·base]
  }));
}

describe('cohortStats', () => {
  it('skips null/blank divisions and non-finite amounts', () => {
    const stats = cohortStats([
      { division: '45', amountEur: 100 },
      { division: '', amountEur: 100 },
      { division: '45', amountEur: Number.NaN },
      { division: '45', amountEur: 200 },
    ]);
    expect(stats.get('45')!.count).toBe(2);
    expect(stats.has('')).toBe(false);
  });
});

describe('cpvCohortOutliers', () => {
  it('flags a gross outlier above cohortFactor × p95 and sorts by ratio', () => {
    const rows = [
      ...cohort('45', 200, 100_000), // p95 ≈ 138k
      { id: 'big', division: '45', amountEur: 50_000_000 }, // ~360× p95
      { id: 'bigger', division: '45', amountEur: 90_000_000 },
    ];
    const out = cpvCohortOutliers(rows);
    expect(out.total).toBe(2);
    expect(out.examples[0]!.id).toBe('bigger'); // highest ratio first
    expect(out.examples[0]!.ratio).toBeGreaterThan(ANOMALY_DEFAULTS.cohortFactor);
  });

  it('does NOT flag when the cohort is too small to trust', () => {
    const rows = [
      { id: 'a', division: '99', amountEur: 100 },
      { id: 'b', division: '99', amountEur: 200 },
      { id: 'huge', division: '99', amountEur: 100_000_000 },
    ];
    expect(cpvCohortOutliers(rows).total).toBe(0); // cohort < minCohort(12)
  });

  it('does NOT flag a merely-large (within factor) contract', () => {
    const rows = [
      ...cohort('45', 200, 100_000),
      { id: 'large', division: '45', amountEur: 1_000_000 },
    ];
    expect(cpvCohortOutliers(rows).total).toBe(0); // ~7× p95 < 25×
  });

  // Reviewer repro (#148): with a plain p95 the lone outlier contaminates its own anchor — linear
  // interpolation reaches into the outlier for n = 12..20, so a 50M contract in a ~100k cohort sat
  // at only 2–19× "p95" and was never flagged. Leave-one-out p95 must catch it at every size.
  it('flags a lone gross outlier in small cohorts (n = 12..20, leave-one-out p95)', () => {
    for (let n = 12; n <= 20; n++) {
      const rows = [
        ...cohort('45', n - 1, 100_000),
        { id: 'lone', division: '45', amountEur: 50_000_000 },
      ];
      const out = cpvCohortOutliers(rows);
      expect(out.total).toBe(1);
      expect(out.examples[0]!.id).toBe('lone');
      expect(out.examples[0]!.ratio).toBeGreaterThan(ANOMALY_DEFAULTS.cohortFactor);
    }
  });
});

describe('decimalShiftSuspects', () => {
  it('flags a gross outlier whose ÷10 or ÷100 lands back near the cohort median', () => {
    const rows = [
      ...cohort('45', 200, 100_000), // median ≈ 112k
      { id: 'shift100', division: '45', amountEur: 100_000 * 100 }, // ÷100 → 100k ≈ median
    ];
    const out = decimalShiftSuspects(rows);
    expect(out.total).toBe(1);
    expect(out.examples[0]).toMatchObject({ id: 'shift100', rescaledBy: 100 });
  });

  // Reviewer repro (#148): a typical ×10 shift sits at only ~8–9× its cohort p95 — far below the
  // 25× gross gate the old code required first — so the single misplaced decimal (the most common
  // loader artifact, and this detector's headline case) was undetectable. The rescale test must
  // run independently of the gross-outlier gate.
  it('flags a single ×10 shift that is NOT a 25× gross outlier (€112k cohort → €1.12M row)', () => {
    const rows = [
      ...cohort('45', 200, 100_000), // median ≈ 112k, band [56k, 224k]
      { id: 'shift10', division: '45', amountEur: 1_120_000 }, // ÷10 → 112k ≈ median; only ~9× p95
    ];
    expect(cpvCohortOutliers(rows).total).toBe(0); // sanity: below the gross gate…
    const out = decimalShiftSuspects(rows);
    expect(out.total).toBe(1); // …yet the decimal shift is caught
    expect(out.examples[0]).toMatchObject({ id: 'shift10', rescaledBy: 10 });
  });

  it('does NOT flag a row inside the cohort band (nothing to rescale)', () => {
    const rows = [
      ...cohort('45', 200, 100_000),
      { id: 'normal-large', division: '45', amountEur: 220_000 }, // within [median/2, median×2]
    ];
    expect(decimalShiftSuspects(rows).total).toBe(0);
  });

  it('does NOT flag values in the exclusion gap between the ÷10 and ÷100 windows', () => {
    // Regression for the vacuous-band defect: with decimalRescaleMax=2 only (5×,20×] median
    // reads as ÷10 and (50×,200×] as ÷100. A legit large award at ~30× median rescales to
    // 3× median (outside the band both ways) and must NOT be labeled a decimal shift.
    const rows = [
      ...cohort('45', 200, 100_000), // median ≈ 112k
      { id: 'legit-30x', division: '45', amountEur: 3_400_000 }, // ÷10 = 340k > 2×median; ÷100 = 34k < median/2
    ];
    expect(decimalShiftSuspects(rows).total).toBe(0);
  });

  it('does NOT flag a gross outlier that stays gross after rescale', () => {
    const rows = [
      ...cohort('45', 200, 100_000),
      { id: 'truly-huge', division: '45', amountEur: 5_000_000_000 },
    ];
    // ÷100 = 50M, still ≫ median×8 → not a decimal shift, just huge
    expect(decimalShiftSuspects(rows).total).toBe(0);
  });
});

describe('buildAnomalyReport / formatAnomalyReport', () => {
  const fixtureRows = [
    ...cohort('45', 200, 100_000), // median ≈ 112k, band [56k, 224k]
    { id: 'big', division: '45', amountEur: 93_000_000 }, // gross outlier; ÷100 = 930k and ÷10 = 9.3M both stay outside [median/2, median×2]
    { id: 'shift', division: '45', amountEur: 100_000 * 100 }, // gross outlier AND ÷100 decimal shift
  ];
  const runner: AnomalyRunner = (sql: string) =>
    sql.includes('FROM contracts') ? (fixtureRows as Array<Record<string, unknown>>) : [];

  it('assembles findings and dedupes the headline total by contract id', () => {
    const report = buildAnomalyReport(runner);
    expect(report.sampled).toBe(fixtureRows.length);
    expect(report.findings.map((f) => f.key)).toEqual(['cpv-cohort-outlier', 'decimal-shift']);
    // 'big' and 'shift' are both cohort outliers; 'shift' is ALSO a decimal-shift suspect. The
    // per-finding totals keep their own counts, but the headline total must count 'shift' ONCE.
    expect(report.findings[0]!.total).toBe(2);
    expect(report.findings[1]!.total).toBe(1);
    expect(report.total).toBe(2); // NOT 3 — deduped across findings
  });

  it('counts a decimal shift that is not a gross outlier exactly once', () => {
    const rows = [
      ...cohort('45', 200, 100_000),
      { id: 'shift10', division: '45', amountEur: 1_120_000 }, // decimal-shift only (~9× p95)
    ];
    const report = buildAnomalyReport(() => rows as Array<Record<string, unknown>>);
    expect(report.findings[0]!.total).toBe(0);
    expect(report.findings[1]!.total).toBe(1);
    expect(report.total).toBe(1);
  });

  it('formats a bounded, human-readable summary', () => {
    const text = formatAnomalyReport(buildAnomalyReport(runner));
    expect(text).toContain('anomaly report');
    expect(text).toMatch(/cpv-cohort-outlier/);
    expect(text.split('\n').length).toBeLessThan(40); // bounded
  });

  it('tolerates an empty corpus', () => {
    const empty = buildAnomalyReport(() => []);
    expect(empty).toMatchObject({ sampled: 0, total: 0 });
  });
});
