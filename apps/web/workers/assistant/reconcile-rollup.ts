// E4 — Guard B: reconcile-with-rollup.
//
// When the assistant computes an aggregate (a COUNT/SUM over filtered contracts) for a scope that a
// precomputed rollup also covers, it must reconcile the two AT THE SAME GRAIN before presenting a
// number. The rollups (sector_totals, authority_totals, company_totals) are built with the invariant
// that every (count, sum) pair ranges over exactly the `amount_eur IS NOT NULL AND is_synthetic != 1`
// rows — the SAME basis the assistant's default filters apply (default-filters.ts excludes synthetic
// 'неизвестна' orphan headers) — so a live aggregate that disagrees means a filter or join drifted.
// On mismatch we BLOCK and surface the
// discrepancy — we never silently substitute one figure for the other, because either could be the
// wrong one. Money is REAL (float), so sums reconcile within a tolerance; counts must match exactly.
//
// VALID RECONCILE TARGETS: only the amount_eur + non-synthetic rollups above. Do NOT reconcile a
// count against `home_totals.contracts` — that column is a synthetic-inclusive corpus `COUNT(*)` over
// ALL contracts (incl. NULL-amount rows), a different row-set; reconciling against it would throw on
// a correct number.

export interface Aggregate {
  /** The exact grain this figure is computed at, e.g. { division: '45', year: '2024' }. */
  grain: Record<string, string>;
  count: number;
  sumEur: number;
}

export interface ReconcileOptions {
  /** Absolute euro tolerance floor for the sum comparison. Default 0.5. */
  absoluteTolerance?: number;
  /** Relative tolerance factor applied to |rollup.sumEur|. Default 1e-9. */
  relativeTolerance?: number;
}

export type MismatchKind = 'grain' | 'count' | 'sum';

export interface Mismatch {
  kind: MismatchKind;
  detail: string;
}

export interface ReconcileReport {
  ok: boolean;
  mismatches: Mismatch[];
  /** The tolerance actually used for the sum comparison (for surfacing/auditing). */
  epsilon: number;
}

const DEFAULT_ABSOLUTE_TOLERANCE = 0.5;
const DEFAULT_RELATIVE_TOLERANCE = 1e-9;

function grainKey(grain: Record<string, string>): string {
  return Object.keys(grain)
    .sort()
    .map((k) => `${k}=${grain[k]}`)
    .join('&');
}

function reconcileGrain(aggregate: Aggregate, rollup: Aggregate): Mismatch | null {
  const a = grainKey(aggregate.grain);
  const b = grainKey(rollup.grain);
  if (a !== b) {
    return {
      kind: 'grain',
      detail: `grain mismatch: aggregate {${a}} vs rollup {${b}} — reconciling at the wrong grain`,
    };
  }
  return null;
}

function reconcileCount(aggregate: Aggregate, rollup: Aggregate): Mismatch | null {
  if (!Number.isFinite(aggregate.count) || !Number.isFinite(rollup.count)) {
    return {
      kind: 'count',
      detail: `non-finite count: aggregate ${aggregate.count} vs rollup ${rollup.count}`,
    };
  }
  if (aggregate.count !== rollup.count) {
    return {
      kind: 'count',
      detail: `count mismatch: aggregate ${aggregate.count} vs rollup ${rollup.count}`,
    };
  }
  return null;
}

function reconcileSum(aggregate: Aggregate, rollup: Aggregate, epsilon: number): Mismatch | null {
  if (!Number.isFinite(aggregate.sumEur) || !Number.isFinite(rollup.sumEur)) {
    return {
      kind: 'sum',
      detail: `non-finite sum: aggregate ${aggregate.sumEur} vs rollup ${rollup.sumEur}`,
    };
  }
  const diff = Math.abs(aggregate.sumEur - rollup.sumEur);
  if (diff > epsilon) {
    return {
      kind: 'sum',
      detail: `sum mismatch: aggregate ${aggregate.sumEur} vs rollup ${rollup.sumEur} (|Δ| ${diff} > ε ${epsilon})`,
    };
  }
  return null;
}

/**
 * Reconcile a computed aggregate against a fixed-scope rollup at its exact grain.
 * Counts must match exactly; REAL sums within `max(absoluteTolerance, relativeTolerance·|rollup|)`.
 * Returns every mismatch found; never mutates or substitutes either input.
 */
export function reconcile(
  aggregate: Aggregate,
  rollup: Aggregate,
  options: ReconcileOptions = {},
): ReconcileReport {
  const absolute = options.absoluteTolerance ?? DEFAULT_ABSOLUTE_TOLERANCE;
  const relative = options.relativeTolerance ?? DEFAULT_RELATIVE_TOLERANCE;
  const epsilon = Math.max(absolute, relative * Math.abs(rollup.sumEur));

  const mismatches = [
    reconcileGrain(aggregate, rollup),
    reconcileCount(aggregate, rollup),
    reconcileSum(aggregate, rollup, epsilon),
  ].filter((m): m is Mismatch => m !== null);

  return { ok: mismatches.length === 0, mismatches, epsilon };
}

export class ReconcileError extends Error {
  readonly mismatches: Mismatch[];
  readonly report: ReconcileReport;

  constructor(report: ReconcileReport) {
    super(`reconciliation failed: ${report.mismatches.map((m) => m.detail).join('; ')}`);
    this.name = 'ReconcileError';
    this.mismatches = report.mismatches;
    this.report = report;
  }
}

/**
 * Block-and-surface variant: throws `ReconcileError` (carrying the mismatch detail) when the
 * aggregate and rollup disagree, so the caller surfaces the discrepancy instead of substituting.
 */
export function assertReconciled(
  aggregate: Aggregate,
  rollup: Aggregate,
  options: ReconcileOptions = {},
): ReconcileReport {
  const report = reconcile(aggregate, rollup, options);
  if (!report.ok) throw new ReconcileError(report);
  return report;
}
