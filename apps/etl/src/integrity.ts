import { runIntegrityChecks, type IntegrityResult } from '../../../scripts/integrity-checks.mjs';

// The cron refresh writes to the served D1 directly (no work-DB/ship step). Before this gate the
// steady-state path ran NONE of the reconciliation checks the CLI paths run (import.mjs /
// ship-domain.mjs) — silent under-insertion, mis-attribution or a negative rollup could drift the
// minister-visible numbers with no alert. This runs the shared gate (#97) against the served D1 after
// each slice derive. The same refresh-slice.sql is proven gate-green by packages/db's refresh-slice
// test, so a clean slice passes; only genuine drift fails. See issue #154.

// Structured log sink. The Workflow passes console-backed JSON emitters; kept injectable so the
// evaluation logic is unit-testable without console side effects.
export interface GateLog {
  info: (event: Record<string, unknown>) => void;
  warn: (event: Record<string, unknown>) => void;
  error: (event: Record<string, unknown>) => void;
}

const brief = (r: IntegrityResult) => ({ name: r.name, detail: r.detail });

// Turn gate results into log events + a throw decision. WARN-only results (e.g. out-of-range upstream
// dates) are alerted but never fail. A real violation (not skipped, not ok) is alerted AND throws, so
// the Workflow step fails and surfaces in Cloudflare observability instead of silently serving drifted
// numbers. Pure (no I/O beyond the injected logger) so it is unit-testable without a D1.
export function evaluateIntegrity(results: IntegrityResult[], log: GateLog): void {
  const warned = results.filter((r) => r.warn);
  const failed = results.filter((r) => !r.skipped && !r.ok);
  if (warned.length) log.warn({ event: 'etl_integrity_warn', checks: warned.map(brief) });
  if (failed.length) {
    log.error({ event: 'etl_integrity_violation', checks: failed.map(brief) });
    throw new Error(`integrity gate failed: ${failed.map((r) => r.name).join(', ')}`);
  }
  log.info({
    event: 'etl_integrity_ok',
    ran: results.filter((r) => !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
  });
}

// Run the shared reconciliation gate against the served D1 and evaluate it. The runner is async (D1
// `.all()` is a Promise); integrity-checks awaits it. On the served D1 the rollup checks run (rollups
// exist) and staging-reconciliation self-skips (pipeline_stats is not shipped). FX-rate priced-ness is
// intentionally NOT gated here: the Worker does not load FX rates, so enforcing it would fail every
// refresh that carries a foreign-currency contract — that needs its own decision (issue #154).
export async function runServedIntegrityGate(db: D1Database, log: GateLog): Promise<void> {
  const runner = async (sql: string) => (await db.prepare(sql).all()).results;
  const results = await runIntegrityChecks(runner);
  evaluateIntegrity(results, log);
}
