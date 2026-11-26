import {
  BREATHER_MS,
  HEAVY_ROWS,
  runIntegrityChecks,
  summarizeIntegrity,
  type IntegrityResult,
} from '../../../scripts/integrity-checks.mjs';

export { BREATHER_MS, HEAVY_ROWS };

// The cron refresh writes to the served D1 directly (no work-DB/ship step). Before this gate the
// steady-state path ran NONE of the reconciliation checks the CLI paths run (import.mjs /
// ship-domain.mjs) — silent under-insertion, mis-attribution or a negative rollup could drift the
// minister-visible numbers with no alert. This runs the shared gate (#97) against the served D1 after
// each slice derive. See issue #154.
//
// IMPORTANT — this is a POST-COMMIT alarm, not a barrier. The slice is already applied to (and served
// from) the D1 by the time the gate runs, so a violation cannot un-serve anything and failing the run
// over it would protect nothing. It is logged at error level and reported back; the Workflow keeps the
// window recorded, so the next run replays it and checks again. The proper end state (derive in
// staging + atomic swap) is the platform-wide follow-up noted in the gate doc.

// Structured log sink. The Workflow passes console-backed JSON emitters; injectable so the gate is
// unit-testable without console side effects.
export interface GateLog {
  info: (event: Record<string, unknown>) => void;
  warn: (event: Record<string, unknown>) => void;
  error: (event: Record<string, unknown>) => void;
}

const brief = (r: IntegrityResult) => ({ name: r.name, detail: r.detail });

// Run the shared gate against the served D1, emit structured observability events, and return whether
// the numbers reconcile. The verdict comes from `summarizeIntegrity` — the SAME reducer assertIntegrity
// uses — so the cron path and the CLI paths can never report a different decision. The runner is async
// (D1 `.all()` is a Promise); integrity-checks awaits it. On the served D1 the rollup checks run and
// staging-reconciliation self-skips (pipeline_stats is not shipped). FX priced-ness is not yet gated —
// the Worker DOES load FX since #263, so a follow-up check belongs in the shared roster (#154).
// A query that fails (an overloaded D1) throws: that is not a verdict, and the step retries it.
//
// The served D1 allows only so much work inside any ten seconds, and the gate runs straight after the
// slice derive has spent most of that. Its heavier checks read the contracts whole, so run back to back
// they add up to the limit by themselves — and a retry then repeats the same burst and fails the same
// way. After a query that read a table's worth of rows the gate therefore waits before the next one
// (HEAVY_ROWS, BREATHER_MS — shared with the slot rebuild's verification, scripts/integrity-checks.mjs).

export async function runServedIntegrityGate(
  db: D1Database,
  log: GateLog,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<boolean> {
  const runner = async (sql: string) => {
    const { results, meta } = await db.prepare(sql).all();
    if (Number(meta?.rows_read ?? 0) >= HEAVY_ROWS) await pause(BREATHER_MS);
    return results;
  };
  const results = await runIntegrityChecks(runner);
  const summary = summarizeIntegrity(results, 'cron refresh');
  if (summary.warned.length) {
    log.warn({ event: 'etl_integrity_warn', checks: summary.warned.map(brief) });
  }
  if (!summary.ok) {
    log.error({ event: 'etl_integrity_violation', checks: summary.violations.map(brief) });
    return false;
  }
  log.info({ event: 'etl_integrity_ok', ran: summary.ran, skipped: summary.skipped });
  return true;
}
