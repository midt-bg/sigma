// The procurement refresh's last integrity verdict, as the ETL stores it (packages/ingest refresh.ts,
// recordRefreshVerdict): one row per run in the runtime table `refresh_verdict`, which the refresh
// creates itself. This is the read a status surface (a health endpoint, an admin view, a deploy check)
// runs — one row, by index. See docs/integrity-gate.md.
//
// Only `ok` is healthy. `violation` (a check broke) and `unverified` (a check could not complete) are
// both reported as not healthy: neither says the numbers reconcile. A run that had nothing to verify
// (`skipped`) is never the verdict — it would read as a fresh `ok` it never earned — but it does count
// as the refresh having run, which is what `lastRunAt` says.

export type RefreshVerdictState = 'ok' | 'violation' | 'unverified';

export interface RefreshVerdictStatus {
  verdict: RefreshVerdictState;
  /** True only for `ok`. */
  healthy: boolean;
  /** When the gate decided (ISO). */
  decidedAt: string;
  /** Check names only: the ones that broke, or the one that could not complete. */
  checks: string[];
  /** The contract window the run refreshed. */
  windowFrom: string;
  windowTo: string;
  /** When the run was created (ISO) — which run it was, without exposing its instance id. */
  runStartedAt: string;
  /** When the refresh last recorded anything, a run with nothing to verify included. A reader compares
   *  this — and `decidedAt` — with the clock: a run that errored before the gate records nothing, so an
   *  old `ok` stays the latest row until the next run reaches the gate. */
  lastRunAt: string;
}

export const LATEST_REFRESH_VERDICT_SQL = `SELECT v.verdict, v.decided_at, v.checks, v.window_from, v.window_to, v.run_started_at,
  (SELECT MAX(decided_at) FROM refresh_verdict) AS last_run_at
FROM refresh_verdict v
WHERE v.verdict <> 'skipped'
ORDER BY v.decided_at DESC
LIMIT 1`;

interface Row {
  verdict: RefreshVerdictState;
  decided_at: string;
  checks: string;
  window_from: string;
  window_to: string;
  run_started_at: string;
  last_run_at: string;
}

// Only THIS table's absence means „no refresh has run against this database yet" (a fresh slot, a
// local D1). Every other error — an overloaded D1 included — propagates.
const MISSING = /no such table:\s*(?:main\.)?"?refresh_verdict"?/i;

/** The latest stored verdict, or null when no run has reached the gate on this database. */
export async function getLatestRefreshVerdict(
  db: D1Database,
): Promise<RefreshVerdictStatus | null> {
  let row: Row | null;
  try {
    row = await db.prepare(LATEST_REFRESH_VERDICT_SQL).first<Row>();
  } catch (e) {
    if (e instanceof Error && MISSING.test(e.message)) return null;
    throw e;
  }
  if (!row) return null;
  return {
    verdict: row.verdict,
    healthy: row.verdict === 'ok',
    decidedAt: row.decided_at,
    checks: JSON.parse(row.checks) as string[],
    windowFrom: row.window_from,
    windowTo: row.window_to,
    runStartedAt: row.run_started_at,
    lastRunAt: row.last_run_at,
  };
}
