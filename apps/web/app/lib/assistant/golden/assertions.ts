// The six golden integrity assertions.
//
// Each is a pure, framework-agnostic exported function that THROWS a descriptive Error on violation and
// returns normally on success — so a positive fixture wraps them in `expect(fn).not.toThrow()` and a
// negative fixture in `expect(fn).toThrow()`. They read the REAL pipeline outputs produced by
// replay.ts; none re-implements pipeline logic.

import {
  asNumber,
  type BindResult,
  type ResolvedReport,
  type ResolvedBlock,
} from '../report-schema';
import { assertDefaultFilters } from '../assert-default-filters';
import {
  applyDefaultFilters,
  type DefaultFilterOptions,
} from '../../../../workers/assistant/default-filters';
import type { GoldenFixture } from './types';

/** The exact success string the production `reconcile_rollup` tool returns when the two sides agree. */
export const RECONCILED = 'Съгласувано.';

/** A SUM over a non-canonical amount column (`SUM(amount)` / `SUM(c.amount)`) — never `amount_eur`. */
const NON_CANONICAL_SUM = /\bsum\s*\(\s*[a-z]*\.?amount(?!_eur)\b/i;

function requireOk(bind: BindResult): ResolvedReport {
  if (!bind.ok) {
    throw new Error(`finalizeReport failed: ${bind.errors.join('; ')}`);
  }
  return bind.report;
}

// ── 1. Schema validity ────────────────────────────────────────────────────────────────────────────
// The recorded emit re-binds to a structurally valid resolved report. Negative: a dangling handle /
// missing-column reference makes bindReport return errors instead of a report.
export function assertSchemaValid(bind: BindResult): void {
  requireOk(bind);
}

// ── 2. Canonical amount usage ─────────────────────────────────────────────────────────────────────
// Every contracts-reading step sums money via `amount_eur` and NEVER via the raw display `amount`
// column (the SUM(amount) → garbage-total-attributed-to-АОП vector, describe-schema.ts trap #1).
export function assertAmountEurUsage(fixture: GoldenFixture): void {
  if (!fixture.expect.queriesContracts) return;
  for (const step of fixture.steps) {
    if (!/amount_eur/i.test(step.sql)) {
      throw new Error(`step SQL queries contracts but never references amount_eur: ${step.sql}`);
    }
    const bad = step.sql.match(NON_CANONICAL_SUM);
    if (bad) {
      throw new Error(`step SQL sums a non-canonical amount column ("${bad[0]}"): ${step.sql}`);
    }
  }
}

// ── 3. Default filters applied ────────────────────────────────────────────────────────────────────
// A contracts step carries the safe default predicates (so the wired gate accepts it). For each
// declared opt-out the matching `ВНИМАНИЕ:` warning line is sourced from `applyDefaultFilters({…})`
// and asserted distinct from its default counterpart — proving the opt-out machinery surfaces the
// risk to the reader. The callout is NOT asserted to appear in the rendered report: it was removed
// from finalizeReport to avoid surfacing raw DB field names/values in the UI (E3 gate still runs).
const OPTOUT_OPTIONS: Record<string, DefaultFilterOptions> = {
  includeUnsummable: { includeUnsummable: true },
  includeSynthetic: { includeSynthetic: true },
  publishedAt: { dateField: 'published_at' },
};

export function assertDefaultFiltersApplied(fixture: GoldenFixture): void {
  if (fixture.expect.queriesContracts) {
    for (const step of fixture.steps) {
      const gate = assertDefaultFilters(step.sql);
      if (!gate.ok) {
        throw new Error(`default-filter gate rejected a contracts step: ${gate.reason}`);
      }
      if (gate.callout.length === 0) {
        throw new Error(`contracts step produced no default-filter callout: ${step.sql}`);
      }
    }
  }

  for (const optOut of fixture.expect.optOuts ?? []) {
    const options = OPTOUT_OPTIONS[optOut];
    if (!options) throw new Error(`unknown opt-out "${optOut}"`);
    const warning = applyDefaultFilters(options).callout.find((line) =>
      line.startsWith('ВНИМАНИЕ:'),
    );
    if (!warning) {
      throw new Error(`opt-out "${optOut}" surfaced no ВНИМАНИЕ warning line`);
    }
    const isDefault = applyDefaultFilters().callout.includes(warning);
    if (isDefault) {
      throw new Error(`opt-out "${optOut}" warning is identical to a default line`);
    }
  }
}

// ── 4. Rollup reconciliation ──────────────────────────────────────────────────────────────────────
// A presented count/sum reconciles against a precomputed rollup AT THE SAME GRAIN — verified by driving
// the REAL production `reconcile_rollup` tool through replay (replay.ts), NOT by comparing two
// author-written literals. Both sides are read from actual replayed result handles: the aggregate from
// the live run_sql result the report binds (`R1…`), the rollup from a second run_sql executed after
// finalize. `reconcileReturn` is that tool's verbatim output; on success it is exactly `RECONCILED`
// ('Съгласувано.'). A `home_totals` target is rejected by the tool, and a count/sum mismatch surfaces
// the discrepancy — both yield a non-RECONCILED string, which this asserts is a violation. So a real
// pipeline divergence (a wrong bound figure, a drifted filter/join) fails assertion 4.
export function assertReconcile(fixture: GoldenFixture, reconcileReturn: string | undefined): void {
  if (!fixture.expect.reconcile) return;
  if (reconcileReturn === undefined) {
    throw new Error(
      'reconcile expectation present but reconcile_rollup was not driven by the replay',
    );
  }
  if (reconcileReturn !== RECONCILED) {
    throw new Error(`reconcile_rollup did not reconcile the presented figure: ${reconcileReturn}`);
  }
}

// ── 5. No prose figures ───────────────────────────────────────────────────────────────────────────
// The binder's deterministic material-number gate (guardrail E2) holds: a clean report binds, while an
// emit that smuggles a material number into text/callout prose fails to bind (the "12 млрд." vector).
export function assertNoProseFigures(bind: BindResult): void {
  requireOk(bind);
}

// ── 6. No NaN / empty data ────────────────────────────────────────────────────────────────────────
// Every numeric value the report presents is finite (never null/NaN), and no data block renders an
// empty array unless the fixture declares the result legitimately empty.
function blockArrayLength(block: ResolvedBlock): number | null {
  switch (block.type) {
    case 'table':
      return block.rows.length;
    case 'bar':
    case 'timeseries':
      return block.points.length;
    case 'flows':
      return block.edges.length;
    default:
      return null; // text/callout/totals/facts carry no point array
  }
}

export function assertNoNaNOrEmpty(report: ResolvedReport, emptyOk = false): void {
  for (const block of report.blocks) {
    // Numeric finiteness for the clearly-numeric value slots.
    if (block.type === 'totals') {
      for (const item of block.items) {
        if (item.format === 'money' || item.format === 'number' || item.format === 'percent') {
          const n = asNumber(item.value);
          if (n === null || !Number.isFinite(n)) {
            throw new Error(
              `totals item "${item.label}" has a non-finite numeric value: ${item.value}`,
            );
          }
        }
      }
    } else if (block.type === 'bar') {
      for (const p of block.points) {
        if (!Number.isFinite(p.value))
          throw new Error(`bar point has a non-finite value: ${p.value}`);
      }
    } else if (block.type === 'timeseries') {
      for (const p of block.points) {
        if (!Number.isFinite(p.value))
          throw new Error(`timeseries point has a non-finite value: ${p.value}`);
      }
    } else if (block.type === 'flows') {
      for (const e of block.edges) {
        if (!Number.isFinite(e.valueEur))
          throw new Error(`flow edge has a non-finite value: ${e.valueEur}`);
      }
    } else if (block.type === 'facts') {
      // facts items surface numbers via refs (e.g. value_eur, contracts, authorities). A string or
      // null value is a legitimate display ('—'), but a numeric value that resolved to NaN/Infinity
      // must be caught here too — the assertion's contract is "every numeric value the report
      // presents is finite", and facts were previously skipped entirely.
      for (const item of block.items) {
        if (typeof item.value === 'number' && !Number.isFinite(item.value)) {
          throw new Error(
            `facts item "${item.term}" has a non-finite numeric value: ${item.value}`,
          );
        }
      }
    }

    // Non-empty data arrays unless the fixture allows an empty result.
    const len = blockArrayLength(block);
    if (len !== null && len === 0 && !emptyOk) {
      throw new Error(`${block.type} block renders an empty data array but emptyOk is not set`);
    }
  }
}
