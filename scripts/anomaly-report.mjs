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
  // A ÷10 or ÷100 rescale must land within [median/2, median×2] to read as a shift. The band
  // ratio MUST stay < 10: at ratio ≥ 10 the ÷10 and ÷100 acceptance windows tile contiguously
  // and the check degenerates to "flag anything above the band" (at the old value 8 that meant
  // everything in 8×–800× median read as a decimal shift). Ratio 4 leaves real exclusion gaps:
  // only (5×,20×] median reads as ÷10 and (50×,200×] as ÷100.
  decimalRescaleMax: 2,
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

/**
 * Leave-one-out percentile: linear-interpolation percentile over `sorted` (ascending, finite) with
 * the element at `excludeIndex` removed — WITHOUT materialising the n−1 copy (index math instead),
 * so per-row leave-one-out stays O(1) after the per-division sort. Why it exists: with a plain p95
 * over a cohort that CONTAINS the candidate, a lone gross outlier drags its own anchor upward —
 * linear interpolation reaches into the outlier for cohorts of 12–20 rows, making the exact case
 * the report exists for invisible there. Excluding the candidate from its own percentile closes
 * that blind spot at any cohort size. Pure.
 */
export function percentileExcluding(sorted, excludeIndex, q) {
  const n = sorted.length;
  if (n <= 1) return 0; // nothing left after exclusion
  const at = (k) => sorted[k < excludeIndex ? k : k + 1];
  const m = n - 1;
  if (m === 1) return at(0);
  const pos = (m - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? at(lo) : at(lo) + (at(hi) - at(lo)) * (pos - lo);
}

/** Group rows into per-division ASCENDING sorted finite amounts. Shared by stats + detectors. */
function sortedAmountsByDivision(rows) {
  const byDivision = new Map();
  for (const r of rows) {
    const div = r.division;
    const amt = Number(r.amountEur);
    if (div == null || div === '' || !Number.isFinite(amt)) continue;
    if (!byDivision.has(div)) byDivision.set(div, []);
    byDivision.get(div).push(amt);
  }
  for (const amts of byDivision.values()) amts.sort((a, b) => a - b);
  return byDivision;
}

/** Leftmost index of `value` in ascending `sorted` (value is guaranteed present by construction). */
function indexOfSorted(sorted, value) {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Group `{ division, amountEur }` rows into per-division stats (count, median, p95). Pure. */
export function cohortStats(rows) {
  const stats = new Map();
  for (const [div, amts] of sortedAmountsByDivision(rows)) {
    stats.set(div, {
      count: amts.length,
      median: percentile(amts, 0.5),
      p95: percentile(amts, 0.95),
    });
  }
  return stats;
}

/**
 * Contracts whose amount_eur grossly exceeds their CPV-division cohort (> cohortFactor × the
 * LEAVE-ONE-OUT p95 — the candidate is excluded from its own percentile, see percentileExcluding),
 * only for divisions with a trustworthy sample (≥ minCohort rows including the candidate). Pure:
 * rows are `{ id, division, amountEur }`. Returns all hit ids (for cross-finding dedupe) plus a
 * bounded examples list.
 */
export function cpvCohortOutliers(rows, opts = {}) {
  const { minCohort, cohortFactor, topExamples } = { ...ANOMALY_DEFAULTS, ...opts };
  const byDivision = sortedAmountsByDivision(rows);
  const hits = [];
  for (const r of rows) {
    const amt = Number(r.amountEur);
    const amts = byDivision.get(r.division);
    if (!amts || amts.length < minCohort || !Number.isFinite(amt)) continue;
    const p95 = percentileExcluding(amts, indexOfSorted(amts, amt), 0.95);
    if (p95 <= 0) continue;
    const ratio = amt / p95;
    if (ratio > cohortFactor) {
      hits.push({ id: r.id, division: r.division, amountEur: amt, cohortP95: p95, ratio });
    }
  }
  hits.sort((a, b) => b.ratio - a.ratio);
  return { total: hits.length, ids: hits.map((h) => h.id), examples: hits.slice(0, topExamples) };
}

/**
 * Likely decimal-shift artifacts: a contract ABOVE its cohort's normal band whose amount ÷10 or
 * ÷100 falls back inside that band [median/decimalRescaleMax, median×decimalRescaleMax]; the band
 * ratio is kept < 10 so the ÷10/÷100 acceptance windows stay disjoint (median is leave-one-out,
 * so the candidate can't drag its own anchor). That pattern — "valid number, wrong
 * magnitude" — is exactly what per-row value_flag cannot catch. Deliberately NOT gated behind the
 * cohortFactor gross-outlier test: a typical ×10-shifted contract sits at only ~8–10× its cohort,
 * far below the 25× gross bar, so gating there made the single-decimal shift — the most common
 * loader artifact — undetectable. Being outside the band plus rescaling back into it IS the signal.
 * Pure. Returns all hit ids (for cross-finding dedupe) plus a bounded examples list.
 */
export function decimalShiftSuspects(rows, opts = {}) {
  const { minCohort, decimalRescaleMax, topExamples } = { ...ANOMALY_DEFAULTS, ...opts };
  const byDivision = sortedAmountsByDivision(rows);
  const hits = [];
  for (const r of rows) {
    const amt = Number(r.amountEur);
    const amts = byDivision.get(r.division);
    if (!amts || amts.length < minCohort || !Number.isFinite(amt)) continue;
    const median = percentileExcluding(amts, indexOfSorted(amts, amt), 0.5);
    if (median <= 0) continue;
    const lo = median / decimalRescaleMax;
    const hi = median * decimalRescaleMax;
    if (amt <= hi) continue; // the original must sit well OUTSIDE the cohort's normal band
    const shift = [10, 100].find((d) => amt / d >= lo && amt / d <= hi);
    if (shift) {
      hits.push({
        id: r.id,
        division: r.division,
        amountEur: amt,
        rescaledBy: shift,
        cohortMedian: median,
      });
    }
  }
  hits.sort((a, b) => b.amountEur - a.amountEur);
  return { total: hits.length, ids: hits.map((h) => h.id), examples: hits.slice(0, topExamples) };
}

const FETCH_PRICED_BY_DIVISION = `
  SELECT c.id AS id, substr(t.cpv_code, 1, 2) AS division, c.amount_eur AS amountEur
  FROM contracts c JOIN tenders t ON t.id = c.tender_id
  WHERE c.amount_eur IS NOT NULL AND t.cpv_code IS NOT NULL AND length(t.cpv_code) >= 2
  ORDER BY c.id`;

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
  // Headline total = UNIQUE contracts across findings. A decimal-shift hit is often also a cohort
  // outlier; summing per-finding totals would double-count it and ~2× inflate the number the
  // reader is asked to trust. Per-finding totals stay per-finding; the headline is deduped by id.
  const flagged = new Set([...cohort.ids, ...decimal.ids]);
  return {
    sampled: priced.length,
    findings: [
      {
        key: 'cpv-cohort-outlier',
        label: 'Договор далеч над CPV кохортата',
        total: cohort.total,
        examples: cohort.examples,
      },
      {
        key: 'decimal-shift',
        label: 'Вероятно изместена десетична',
        total: decimal.total,
        examples: decimal.examples,
      },
    ],
    total: flagged.size,
  };
}

/** Render the report as text for the import log. Pure. */
export function formatAnomalyReport(report) {
  const lines = [
    `anomaly report — ${report.sampled} priced contracts sampled, ${report.total} unique contracts flagged`,
  ];
  for (const f of report.findings) {
    lines.push(`  • ${f.key} (${f.label}): ${f.total}`);
    for (const ex of f.examples.slice(0, 5)) {
      const amt = Math.round(ex.amountEur).toLocaleString('bg-BG');
      const ctx =
        ex.rescaledBy == null
          ? `${ex.ratio.toFixed(1)}× cohort p95`
          : `÷${ex.rescaledBy} → near median`;
      lines.push(`      - ${ex.id}  €${amt}  [CPV ${ex.division}, ${ctx}]`);
    }
  }
  return lines.join('\n');
}
