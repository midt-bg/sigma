// Sigma — per-refresh anomaly report (#100). The per-row `value_flag` system catches a single row's
// own defects (value_suspect / annex_suspect / value_low); this adds the CROSS-row view it can't see:
// a contract far above its CPV-division cohort, and a likely misplaced decimal (a loader artifact that
// is internally "valid" so value_flag passes it). It OBSERVES — it emits a human-readable report each
// refresh and never fails the import (contrast integrity-checks.mjs #97, which is the hard gate).
//
// Design mirrors integrity-checks.mjs: pure functions over an injected `runner(sql) => rows[]`, so the
// SAME logic runs against D1 (wrangler), local sqlite, and unit fixtures. The statistics live in plain
// JS over the fetched rows (the SQL only SELECTs), so every threshold is unit-tested without a DB.
//
// Thresholds are deliberately conservative — the report's value is trust, and a flood of "merely large"
// contracts would train the reader to ignore it. See docs/anomaly-report.md. Coordinates with (does
// not duplicate) the #41 price-deviation risk flag: this is an ETL-time corpus report, not a per-page UI badge.

export const ANOMALY_DEFAULTS = {
  minCohort: 12, // a CPV division needs ≥12 priced contracts before its distribution is trusted
  cohortFactor: 25, // flag a contract whose amount_eur exceeds 25× its cohort p95 (gross, not just big)
  decimalRescaleMax: 8, // a ÷10 or ÷100 rescale must land within [median/8, median×8] to read as a shift
  topExamples: 20, // cap examples carried per finding so the report (and any notification) stays bounded
};

/** Linear-interpolation percentile over a numeric array. `q` in [0,1]. Empty → 0. Pure. */
export function percentile(values, q) {
  const xs = values
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  if (xs.length === 1) return xs[0];
  const pos = (xs.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? xs[lo] : xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

/** Group `{ division, amountEur }` rows into per-division stats (count, median, p95). Pure. */
export function cohortStats(rows) {
  const byDivision = new Map();
  for (const r of rows) {
    const div = r.division;
    const amt = Number(r.amountEur);
    if (div == null || div === '' || !Number.isFinite(amt)) continue;
    if (!byDivision.has(div)) byDivision.set(div, []);
    byDivision.get(div).push(amt);
  }
  const stats = new Map();
  for (const [div, amts] of byDivision) {
    stats.set(div, {
      count: amts.length,
      median: percentile(amts, 0.5),
      p95: percentile(amts, 0.95),
    });
  }
  return stats;
}

/**
 * Contracts whose amount_eur grossly exceeds their CPV-division cohort (> cohortFactor × p95), only
 * for divisions with a trustworthy sample (≥ minCohort). Pure: rows are `{ id, division, amountEur }`.
 */
export function cpvCohortOutliers(rows, opts = {}) {
  const { minCohort, cohortFactor, topExamples } = { ...ANOMALY_DEFAULTS, ...opts };
  const stats = cohortStats(rows);
  const hits = [];
  for (const r of rows) {
    const amt = Number(r.amountEur);
    const c = stats.get(r.division);
    if (!c || c.count < minCohort || c.p95 <= 0 || !Number.isFinite(amt)) continue;
    const ratio = amt / c.p95;
    if (ratio > cohortFactor) {
      hits.push({ id: r.id, division: r.division, amountEur: amt, cohortP95: c.p95, ratio });
    }
  }
  hits.sort((a, b) => b.ratio - a.ratio);
  return { total: hits.length, examples: hits.slice(0, topExamples) };
}

/**
 * Likely decimal-shift artifacts: a gross cohort outlier whose amount ÷10 or ÷100 would fall back
 * inside the cohort's normal band [median/decimalRescaleMax, median×decimalRescaleMax]. That pattern —
 * "valid number, wrong magnitude" — is exactly what per-row value_flag cannot catch. Pure.
 */
export function decimalShiftSuspects(rows, opts = {}) {
  const { minCohort, cohortFactor, decimalRescaleMax, topExamples } = {
    ...ANOMALY_DEFAULTS,
    ...opts,
  };
  const stats = cohortStats(rows);
  const hits = [];
  for (const r of rows) {
    const amt = Number(r.amountEur);
    const c = stats.get(r.division);
    if (!c || c.count < minCohort || c.median <= 0 || !Number.isFinite(amt)) continue;
    if (amt / c.p95 <= cohortFactor) continue; // only consider gross outliers
    const lo = c.median / decimalRescaleMax;
    const hi = c.median * decimalRescaleMax;
    const shift = [10, 100].find((d) => amt / d >= lo && amt / d <= hi);
    if (shift) {
      hits.push({
        id: r.id,
        division: r.division,
        amountEur: amt,
        rescaledBy: shift,
        cohortMedian: c.median,
      });
    }
  }
  hits.sort((a, b) => b.amountEur - a.amountEur);
  return { total: hits.length, examples: hits.slice(0, topExamples) };
}

const FETCH_PRICED_BY_DIVISION = `
  SELECT c.id AS id, substr(t.cpv_code, 1, 2) AS division, c.amount_eur AS amountEur
  FROM contracts c JOIN tenders t ON t.id = c.tender_id
  WHERE c.amount_eur IS NOT NULL AND t.cpv_code IS NOT NULL AND length(t.cpv_code) >= 2`;

function rows(runner, sql) {
  const out = runner(sql);
  return Array.isArray(out) ? out : [];
}

/**
 * Assemble the full report. Impure only in that it calls `runner`; all detection is the pure functions
 * above. Returns a structured object (never throws on findings — observe, not gate).
 */
export function buildAnomalyReport(runner, opts = {}) {
  const priced = rows(runner, FETCH_PRICED_BY_DIVISION).map((r) => ({
    id: r.id,
    division: r.division,
    amountEur: Number(r.amountEur),
  }));
  const cohort = cpvCohortOutliers(priced, opts);
  const decimal = decimalShiftSuspects(priced, opts);
  return {
    sampled: priced.length,
    findings: [
      { key: 'cpv-cohort-outlier', label: 'Договор далеч над CPV кохортата', ...cohort },
      { key: 'decimal-shift', label: 'Вероятно изместена десетична', ...decimal },
    ],
    total: cohort.total + decimal.total,
  };
}

/** Render the report as text for the import log. Pure. */
export function formatAnomalyReport(report) {
  const lines = [
    `anomaly report — ${report.sampled} priced contracts sampled, ${report.total} flagged`,
  ];
  for (const f of report.findings) {
    lines.push(`  • ${f.key} (${f.label}): ${f.total}`);
    for (const ex of f.examples.slice(0, 5)) {
      const amt = Math.round(ex.amountEur).toLocaleString('bg-BG');
      const ctx = ex.ratio
        ? `${ex.ratio.toFixed(1)}× cohort p95`
        : `÷${ex.rescaledBy} → near median`;
      lines.push(`      - ${ex.id}  €${amt}  [CPV ${ex.division}, ${ctx}]`);
    }
  }
  return lines.join('\n');
}
