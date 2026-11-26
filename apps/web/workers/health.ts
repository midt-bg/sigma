import { getDb } from '@sigma/db';
import { sigmaVersion } from '../app/lib/meta';
import { isD1Refusal } from '../app/lib/retry';
import { baseSecurityHeaders } from '../app/lib/security';

// `/health`: what a deploy or a slot switch has to prove, readable without the edge cache (docs/deploy.md,
// „Проверка след внедряване“). The code the Worker runs, the data it is bound to, and the few facts about
// the scheduled runs that a person or a monitor acts on. Technical facts only: no ids of the account or
// the database, no lease holder, no run id, nothing about a person.

export const HEALTH_PATH = '/health';

/** The commit of the build that rendered a response; stored with an edge copy, so a HIT names its build. */
export const VERSION_HEADER = 'X-Sigma-Version';

/**
 * The data generation a response was rendered from: `home_totals.refreshed_at`. A slot rebuild writes it
 * when it publishes; a refresh moves it before its first served write and again after its last, so it
 * says the served data may have changed, not that a run finished (`runs.refresh.verdict` says how the last
 * one ended). The root loader reads that row for the footer anyway, so stamping it costs no query. Stored with the edge copy like any header, a response proves which generation it shows,
 * whether it came from the cache or not.
 */
export const GENERATION_HEADER = 'X-Sigma-Generation';

export type HealthDb = 'ok' | 'overloaded' | 'error';
export type RefreshVerdict = 'ok' | 'violation' | 'unverified';

export interface Health {
  /** `degraded` when the database did not answer; the code fields are still right. */
  status: 'ok' | 'degraded';
  db: HealthDb;
  /** When the database was read. A report is reused for a few seconds, so it can be that much older. */
  checkedAt: string;
  code: { commit: string | null };
  data: {
    /** `data_version`: the rules the slot was built by, when, from which commit. Null before any rebuild. */
    version: number | null;
    builtAt: string | null;
    builtFromCommit: string | null;
    /** The generation pages carry in X-Sigma-Generation. */
    generation: string | null;
    asOf: string | null;
  };
  runs: {
    refresh: {
      /**
       * When a refresh last started or finished writing served data, or a rebuild published: the same
       * value as `data.generation`. Not the end of a completed run; `verdictAt` and `verifiedAt` are.
       */
      publishedAt: string | null;
      /** Windows a run recorded and no passed integrity gate has settled yet (running, stopped or failed). */
      unsettledWindows: number | null;
      /** Seconds since the oldest of them was recorded; null when there is none. */
      oldestUnsettledAgeSeconds: number | null;
      /**
       * What the last run that reached the integrity gate concluded. Only `ok` says the numbers
       * reconcile; null before any run has reached the gate on this slot.
       */
      verdict: RefreshVerdict | null;
      verdictAt: string | null;
      /** When a run last concluded `ok`: how fresh the proof is, whatever came after it. */
      verifiedAt: string | null;
    };
    /**
     * The last closed day whose commercial-register changes the run has scheduled for reading
     * (`registry_entry_state.seeded_through`, the marker the registry run itself advances).
     */
    registry: { changesThrough: string | null };
    /** When the related persons were last published. */
    declarations: { relatedPersonsPublishedAt: string | null };
  };
}

interface CoreRow {
  generation: string | null;
  as_of: string | null;
  version: number | null;
  source_commit: string | null;
  built_at: string | null;
  changes_through: string | null;
  has_windows: number;
  has_related: number;
  has_verdict: number;
}

interface RunRow {
  unsettled: number | null;
  unsettled_since: string | null;
  verdict: RefreshVerdict | null;
  verdict_at: string | null;
  verified_at: string | null;
  related_published_at: string | null;
}

// Statement 1. The single-row tables the migrations create, so present on every served slot, plus whether
// the tables the runs create on first use exist yet: a freshly rebuilt slot may not hold them, and naming
// a missing table fails the whole statement.
const CORE_SQL = `SELECT
  h.refreshed_at AS generation,
  h.as_of AS as_of,
  d.version AS version,
  d.source_commit AS source_commit,
  d.built_at AS built_at,
  r.seeded_through AS changes_through,
  EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'refresh_pending_window') AS has_windows,
  EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rp_generation') AS has_related,
  EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'refresh_verdict') AS has_verdict
FROM (SELECT 1)
LEFT JOIN home_totals h ON h.id = 1
LEFT JOIN data_version d ON d.id = 1
LEFT JOIN registry_entry_state r ON r.id = 1`;

// The refresh's integrity outcome, from the two things a run leaves on record. The windows: a run
// settles the one it recorded only after its gate passed, so a window still there belongs to a run that
// is in progress, stopped or failed. The verdict: the row every run that reached the gate stores in
// `refresh_verdict` (docs/integrity-gate.md) — a run with nothing to verify stores `skipped`, which is
// never read as the verdict, exactly as in `getLatestRefreshVerdict` (@sigma/db).
const REFRESH_SETTLEMENT_SQL = (present: boolean) =>
  present
    ? `(SELECT COUNT(*) FROM refresh_pending_window) AS unsettled,
  (SELECT MIN(started_at) FROM refresh_pending_window) AS unsettled_since`
    : `0 AS unsettled, NULL AS unsettled_since`;

const REFRESH_VERDICT_SQL = (present: boolean) =>
  present
    ? `(SELECT verdict FROM refresh_verdict WHERE verdict <> 'skipped' ORDER BY decided_at DESC LIMIT 1) AS verdict,
  (SELECT MAX(decided_at) FROM refresh_verdict WHERE verdict <> 'skipped') AS verdict_at,
  (SELECT MAX(decided_at) FROM refresh_verdict WHERE verdict = 'ok') AS verified_at`
    : `NULL AS verdict, NULL AS verdict_at, NULL AS verified_at`;

function refreshOutcome(
  run: RunRow | null,
  now: Date,
): Omit<Health['runs']['refresh'], 'publishedAt'> {
  const since = run?.unsettled_since ? Date.parse(run.unsettled_since) : Number.NaN;
  return {
    unsettledWindows: run?.unsettled ?? 0,
    oldestUnsettledAgeSeconds: Number.isNaN(since)
      ? null
      : Math.max(0, Math.floor((now.getTime() - since) / 1000)),
    verdict: run?.verdict ?? null,
    verdictAt: run?.verdict_at ?? null,
    verifiedAt: run?.verified_at ?? null,
  };
}

// Statement 2, only when a run table exists: everything read from them, in one statement.
const RUNS_SQL = (core: Partial<CoreRow>) => `SELECT
  ${REFRESH_SETTLEMENT_SQL(Boolean(core.has_windows))},
  ${REFRESH_VERDICT_SQL(Boolean(core.has_verdict))},
  ${core.has_related ? '(SELECT MAX(published_at) FROM rp_generation)' : 'NULL'} AS related_published_at`;

const short = (commit: string | null | undefined) => (commit ? commit.slice(0, 12) : null);

async function readHealth(db: D1Database, now: Date): Promise<Omit<Health, 'code' | 'checkedAt'>> {
  // A SELECT over `(SELECT 1)` always yields its one row; the fallbacks only satisfy the types.
  const core: Partial<CoreRow> = (await db.prepare(CORE_SQL).first<CoreRow>()) ?? {};
  const run =
    core.has_windows || core.has_related || core.has_verdict
      ? await db.prepare(RUNS_SQL(core)).first<RunRow>()
      : null;
  return {
    status: 'ok',
    db: 'ok',
    data: {
      version: core.version ?? null,
      builtAt: core.built_at ?? null,
      builtFromCommit: short(core.source_commit),
      generation: core.generation ?? null,
      asOf: core.as_of ?? null,
    },
    runs: {
      refresh: { publishedAt: core.generation ?? null, ...refreshOutcome(run, now) },
      registry: { changesThrough: core.changes_through ?? null },
      declarations: { relatedPersonsPublishedAt: run?.related_published_at ?? null },
    },
  };
}

const UNREAD: Omit<Health, 'code' | 'checkedAt' | 'status' | 'db'> = {
  data: { version: null, builtAt: null, builtFromCommit: null, generation: null, asOf: null },
  runs: {
    refresh: {
      publishedAt: null,
      unsettledWindows: null,
      oldestUnsettledAgeSeconds: null,
      verdict: null,
      verdictAt: null,
      verifiedAt: null,
    },
    registry: { changesThrough: null },
    declarations: { relatedPersonsPublishedAt: null },
  },
};

/** The report itself. A refused or failed read is a `degraded` report, never an exception. */
export async function health(env: Env, now = new Date()): Promise<Health> {
  const code = { commit: sigmaVersion() || null };
  try {
    return { ...(await readHealth(getDb(env), now)), checkedAt: now.toISOString(), code };
  } catch (error) {
    const db: HealthDb = isD1Refusal(error) ? 'overloaded' : 'error';
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'health_degraded',
        db,
        error:
          error instanceof Response ? error.status : String((error as Error)?.message ?? error),
      }),
    );
    return { status: 'degraded', db, checkedAt: now.toISOString(), code, ...UNREAD };
  }
}

/** How long an isolate reuses a report, so a burst of checks or monitors costs one read. */
export const HEALTH_REUSE_MS = 5_000;
/** A degraded report is reused for less: a recovered database should show soon. */
export const DEGRADED_REUSE_MS = 2_000;

// Only values cross requests here. A promise belongs to the request that created it: once that request
// ends (a monitor that gave up mid-read), the runtime never settles it for anyone else, so a later caller
// that awaited it would fail. A caller that finds a read under way waits on a promise of its own, which
// the reader resolves with the report, and stops waiting when the read's window is over.
let reused: { readAt: number; until: number; report: Health } | null = null;
let reading: { until: number; waiters: Set<(report: Health) => void> } | null = null;

/**
 * The report, read at most once per isolate every HEALTH_REUSE_MS (DEGRADED_REUSE_MS when degraded).
 * Concurrent callers share the read in flight. Only the report is reused: every response is built anew
 * and stays `no-store`.
 */
export async function reusedHealth(env: Env, now = Date.now()): Promise<Health> {
  if (reused && now < reused.until) return reused.report;
  const current = reading;
  if (current && now < current.until) {
    const report = await reportOf(current, current.until - now);
    // The read under way did not finish in its window: its request may have ended. Read anew.
    return report ?? reusedHealth(env, Date.now());
  }
  const entry: NonNullable<typeof reading> = { until: now + HEALTH_REUSE_MS, waiters: new Set() };
  reading = entry;
  const report = await health(env, new Date(now));
  // A read that outlived its window must not replace the report of the read that replaced it.
  if (!reused || reused.readAt <= now) {
    const until = now + (report.status === 'ok' ? HEALTH_REUSE_MS : DEGRADED_REUSE_MS);
    reused = { readAt: now, until, report };
  }
  if (reading === entry) reading = null;
  for (const deliver of entry.waiters) deliver(report);
  return report;
}

/** The report of the read under way, or null when it has not come within `ms`. */
function reportOf(read: NonNullable<typeof reading>, ms: number): Promise<Health | null> {
  return new Promise((resolve) => {
    const deliver = (report: Health) => {
      clearTimeout(timer);
      resolve(report);
    };
    const timer = setTimeout(() => {
      read.waiters.delete(deliver);
      resolve(null);
    }, ms);
    read.waiters.add(deliver);
  });
}

/**
 * The `/health` response: JSON, `no-store`, never looked up in or written to the edge cache (app.ts
 * answers it before the cache is consulted). A degraded report is still a 200: the Worker answered, and
 * the body's `status` says what it could not read; a monitor has to check that, not the HTTP status.
 */
export async function healthResponse(
  request: Request,
  env: Env,
  production: boolean,
): Promise<Response> {
  const headers = baseSecurityHeaders(production);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Robots-Tag', 'noindex');
  headers.set('X-Edge-Cache', 'BYPASS');
  if (request.method !== 'GET') {
    headers.set('Allow', 'GET, HEAD');
    return new Response(null, { status: 405, headers });
  }
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(await reusedHealth(env)), { headers });
}
