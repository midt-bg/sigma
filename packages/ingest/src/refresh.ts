// Run the scoped re-derive (scripts/refresh-slice.sql) inside D1. The SQL string is injected by the
// caller (the Worker imports it as a bundled text asset) so this stays a pure, testable function.

/** Split a multi-statement SQL script into individual statements. Strips `--` line comments outside
 *  single-quoted string literals, and splits on `;` only outside literals. */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inLiteral = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (!inLiteral && ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      if (i < sql.length) current += sql[i];
      continue;
    }

    if (ch === "'") {
      current += ch;
      if (inLiteral && next === "'") {
        current += next;
        i += 1;
      } else {
        inLiteral = !inLiteral;
      }
      continue;
    }

    if (!inLiteral && ch === ';') {
      const statement = current.trim();
      if (statement.length > 0) statements.push(statement);
      current = '';
      continue;
    }

    current += ch;
  }

  const statement = current.trim();
  if (statement.length > 0) statements.push(statement);
  return statements;
}

export interface RefreshSliceStatementGroup {
  name: string;
  statements: string[];
}

const REFRESH_BATCH_MARKER = /^--\s*@refresh-batch\s+([a-z0-9][a-z0-9-]*)\s*$/i;

/**
 * Group refresh-slice.sql statements by `-- @refresh-batch name` markers. The markers are SQL
 * comments, so sqlite3/.read still sees one valid script, while D1 callers can keep each group under
 * the platform CPU budget.
 */
export function refreshSliceStatementGroups(refreshSliceSql: string): RefreshSliceStatementGroup[] {
  const groups: RefreshSliceStatementGroup[] = [];
  let currentName = 'derive-slice';
  let currentSql = '';

  const flush = () => {
    const statements = splitSqlStatements(currentSql);
    if (statements.length > 0) groups.push({ name: currentName, statements });
    currentSql = '';
  };

  for (const line of refreshSliceSql.split(/\r?\n/)) {
    const marker = line.trim().match(REFRESH_BATCH_MARKER);
    if (marker) {
      flush();
      currentName = marker[1]!;
      continue;
    }
    currentSql += `${line}\n`;
  }
  flush();

  return groups.length > 0
    ? groups
    : [{ name: currentName, statements: splitSqlStatements(refreshSliceSql) }];
}

const TRANSIENT_STAGING_TABLES = [
  'raw_contracts',
  'raw_tenders',
  'raw_amendments',
  'raw_ocds_parties',
  'raw_ocds_lots',
] as const;

// Clean leftovers from crashed refreshes before the 2026-06 staging-table rename.
const LEGACY_TRANSIENT_STAGING_TABLES = [
  'raw_egov_contracts',
  'raw_egov_tenders',
  'raw_egov_amendments',
] as const;

// Scratch tables that live only for the span of a single derive step. Each is DROP-guarded at the top of
// its own script, so it self-heals on the next run; listing it here also sweeps it after an aborted run so
// it never lingers in D1 (review nikimilenkov LOW 2 — #306's value-resolver scratch table). Not part of
// work-staging-schema.sql, so it stays out of transientStagingStatements' recreate path.
const SCRATCH_TABLES = ['amendment_contract_resolve', 'amend_contract_base'] as const;

function touchesTransientStaging(statement: string): boolean {
  return TRANSIENT_STAGING_TABLES.some((table) => statement.includes(table));
}

export function transientStagingStatements(workStagingSchemaSql: string): string[] {
  return splitSqlStatements(workStagingSchemaSql).filter((statement) =>
    touchesTransientStaging(statement),
  );
}

const FULL_CLEAR_MARKER = /^--\s*@full-clear\b/i;
// All three SQLite quoting styles, not just the bare identifier. Rewriting one line as
// `DELETE FROM "search_index";` is a valid, invisible formatting change — and with a bare-only
// matcher it would drop that table out of the guard's list and quietly reopen the hole this parser
// exists to close.
const DELETE_FROM =
  /^DELETE\s+FROM\s+(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))\s*;?\s*$/i;

/**
 * The tables `scripts/normalize-raw.sql` empties before rebuilding the domain from staging, read out
 * of the SQL rather than restated in JS. The guard that consumes this list used to ask about
 * `contracts` alone while the clear had grown to fourteen tables — a hardcoded copy of a destructive
 * list is a data-loss bug on a timer, so the list has exactly one home.
 *
 * Scoped to the `@full-clear` block on purpose: the same file later resets `data_freshness` and
 * `pipeline_stats`, which are per-run metadata. Counting those as corpus would make the guard refuse
 * every full derive, including the initial backfill it is supposed to let through.
 */
export function fullClearTables(normalizeRawSql: string): string[] {
  const tables: string[] = [];
  let inBlock = false;
  for (const line of normalizeRawSql.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (FULL_CLEAR_MARKER.test(trimmed)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    const hit = trimmed.match(DELETE_FROM);
    if (hit) {
      tables.push((hit[1] ?? hit[2] ?? hit[3] ?? hit[4])!);
      continue;
    }
    // Comments and the DROP TABLEs share the block; a blank line ends it.
    if (trimmed === '') break;
  }
  return tables;
}

export function dropTransientStagingStatements(): string[] {
  return [...SCRATCH_TABLES, ...TRANSIENT_STAGING_TABLES, ...LEGACY_TRANSIENT_STAGING_TABLES]
    .reverse()
    .map((table) => `DROP TABLE IF EXISTS ${table}`);
}

export async function createTransientStaging(
  db: D1Database,
  workStagingSchemaSql: string,
): Promise<void> {
  await db.batch(dropTransientStagingStatements().map((s) => db.prepare(s)));
  const statements = transientStagingStatements(workStagingSchemaSql);
  await db.batch(statements.map((s) => db.prepare(s)));
}

export async function dropTransientStaging(db: D1Database): Promise<void> {
  await db.batch(dropTransientStagingStatements().map((s) => db.prepare(s)));
}

export async function runRefreshSliceStatementGroup(
  db: D1Database,
  group: RefreshSliceStatementGroup,
): Promise<void> {
  await db.batch(group.statements.map((s) => db.prepare(s)));
}

export async function refreshDerivedContractCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM contracts WHERE id LIKE 'c:o:%'")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// The touched sets — the contract / bidder / authority ids every derive batch records so the rollups
// recompute exactly those. Unlike every other refresh_* scratch table they are NOT per-window: an
// aborted run has already committed the contracts it inserted AND the ids it touched (each group is
// one atomic D1 batch), so the ids are the only record of which rollups still need recomputing.
// refresh-slice.sql therefore creates them IF NOT EXISTS and drops them only in its `cleanup` batch,
// after the rollups; dropTransientStagingStatements() above deliberately does not list them. These
// two names are the contract between that SQL and the Worker's "may I skip the derive?" question.
export const TOUCHED_SET_TABLES = [
  'refresh_touched_contracts',
  'refresh_touched_bidders',
  'refresh_touched_authorities',
] as const;

export interface PendingTouchedRows {
  contracts: number;
  bidders: number;
  authorities: number;
  /** Sum of the three — zero when no aborted run left work behind (or the tables do not exist). */
  total: number;
}

// How much work an aborted run left behind. The Worker short-circuits an empty ingest window
// ("nothing staged → nothing to derive"); that was wrong whenever a previous run had died between
// `contracts` and the rollups — the leftover ids waited, unrecomputed, until some later window
// happened to touch the same entities. Read before the short-circuit, so a run with nothing new to
// stage still finishes the previous run's rollups. Absent tables (the normal state after a clean
// run) count as zero rather than erroring: their absence IS the "nothing pending" answer.
export async function pendingTouchedRows(db: D1Database): Promise<PendingTouchedRows> {
  const placeholders = TOUCHED_SET_TABLES.map(() => '?').join(', ');
  const present = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
    .bind(...TOUCHED_SET_TABLES)
    .all<{ name: string }>();
  const existing = new Set(present.results.map((r) => r.name));
  const count = async (table: (typeof TOUCHED_SET_TABLES)[number]): Promise<number> => {
    if (!existing.has(table)) return 0;
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    return Number(row?.n ?? 0);
  };
  const contracts = await count('refresh_touched_contracts');
  const bidders = await count('refresh_touched_bidders');
  const authorities = await count('refresh_touched_authorities');
  return { contracts, bidders, authorities, total: contracts + bidders + authorities };
}

// ── refresh lease ──────────────────────────────────────────────────────────────────────────────────
// Refresh writers were never serialised: the cron fires every six hours and a run takes under a
// minute, so overlap needs a manual trigger landing during a cron run — but when it does, the two
// runs share every scratch table. Before the touched sets became durable that was already unsafe
// (each run's `drop-stale-transient-staging` drops the other's raw_* mid-derive); with durable
// touched sets it gained a quieter failure: run A's `cleanup` could drop the ids run B had just
// recorded, and if B then died its contracts would have no recovery record at all. So a run must
// own the served D1 for its whole duration. This is a lease, not a lock: it expires, so a hung or
// killed instance cannot fence the cron out forever, and re-acquiring under the same holder is a
// no-op so a retried step stays idempotent, and it is RENEWED before every writing step
// (renewRefreshLease) so a live run keeps it while a stalled one loses it. Workflow instances only — the CLI full-rebuild paths
// (import.mjs, ship-domain.mjs) are operator-run and rebuild everything; overlapping THOSE with a
// cron run is a pre-existing hazard this lease does not claim to cover.
export const REFRESH_LEASE_TTL_MS = 30 * 60 * 1000;

export interface RefreshLease {
  /** true when this holder owns the lease now (fresh, re-acquired, or taken over from an expired one). */
  acquired: boolean;
  /** Who owns it after the attempt — this holder when acquired, otherwise the live competitor. */
  holder: string | null;
  expiresAt: string | null;
}

export async function acquireRefreshLease(
  db: D1Database,
  holder: string,
  now: Date = new Date(),
  ttlMs: number = REFRESH_LEASE_TTL_MS,
): Promise<RefreshLease> {
  const acquiredAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  // The table exists and the conditional upsert either takes the lease (row absent, expired, or
  // already ours) or leaves the live holder untouched — one atomic batch. The verdict is then READ
  // BACK rather than inferred: D1 does not say whether DO UPDATE's WHERE fired. The read is a
  // separate statement on purpose — batch() results for SELECTs differ between D1 and the SQLite
  // facade the tests run on, and a live holder cannot lose the lease between the two anyway.
  // ISO-8601 UTC strings compare correctly as text.
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS refresh_lease (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         holder TEXT NOT NULL,
         acquired_at TEXT NOT NULL,
         expires_at TEXT NOT NULL
       )`,
    ),
    db
      .prepare(
        `INSERT INTO refresh_lease (id, holder, acquired_at, expires_at) VALUES (1, ?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET holder = ?1, acquired_at = ?2, expires_at = ?3
         WHERE refresh_lease.expires_at <= ?2 OR refresh_lease.holder = ?1`,
      )
      .bind(holder, acquiredAt, expiresAt),
  ]);
  const row = await db
    .prepare('SELECT holder, expires_at FROM refresh_lease WHERE id = 1')
    .first<{ holder: string; expires_at: string }>();
  if (!row) return { acquired: false, holder: null, expiresAt: null };
  return { acquired: row.holder === holder, holder: row.holder, expiresAt: row.expires_at };
}

// Renew — and thereby re-check — the lease before every step that writes. A Workflow step can be
// retried with backoff for far longer than the TTL and the runtime resumes a run from its CACHED
// step results, so "acquired" at step one says nothing about step twenty: without this, a run that
// stalled past the TTL would resume writing next to the instance that took the lease over. The
// conditional UPDATE only ever touches our own row, and the verdict is read back rather than
// inferred from the update (D1 does not report whether a WHERE matched in a way the SQLite facade
// shares). Losing the lease is not retryable: the data path now belongs to someone else.
export async function renewRefreshLease(
  db: D1Database,
  holder: string,
  now: Date = new Date(),
  ttlMs: number = REFRESH_LEASE_TTL_MS,
): Promise<RefreshLease> {
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  await db
    .prepare('UPDATE refresh_lease SET expires_at = ?2 WHERE id = 1 AND holder = ?1')
    .bind(holder, expiresAt)
    .run();
  const row = await db
    .prepare('SELECT holder, expires_at FROM refresh_lease WHERE id = 1')
    .first<{ holder: string; expires_at: string }>();
  if (!row) return { acquired: false, holder: null, expiresAt: null };
  return { acquired: row.holder === holder, holder: row.holder, expiresAt: row.expires_at };
}

// Release only what we hold: a lease that expired and was taken over by a newer run must not be
// deleted from under it by the stale run's finally.
export async function releaseRefreshLease(db: D1Database, holder: string): Promise<void> {
  await db.prepare('DELETE FROM refresh_lease WHERE id = 1 AND holder = ?').bind(holder).run();
}

// ── pending windows (replay of aborted runs) ──────────────────────────────────────────────────────
// The touched sets make the ROLLUPS of an aborted run recoverable; they cannot make the run's
// half-applied window consistent. The groups are separate atomic batches with cross-group data
// dependencies — `synthetic-tenders` rewrites a procedure's estimate, `contracts` classifies its
// contracts against that estimate one batch later — so a death in between leaves rows derived from
// two different states of the window, and no later window re-derives them: after an abort
// data_freshness.as_of is NULL and the planner falls back to a three-day lookback from today.
// The cure is to REPLAY: a run records the exact [from, to] it is about to cover before it stages
// anything, and after the served gate passed the covered range is SUBTRACTED from every recorded
// promise — a promise inside the range is deleted, one straddling it is shrunk to what is still
// outstanding, one outside it is left untouched. Promises are therefore a LIST of intervals that
// only ever shrink; nothing merges them into a hull that could grow to include days already
// covered. The planner takes the hull of all promises plus its own window only to decide WHAT to
// load (bounded by the same cap as any catch-up); the record is always the actual coverage.
// A promise the cap keeps out of reach stays on record, run after run, until a run whose coverage
// spans it settles it — an operator does that with a manual trigger wide enough, or covers it with
// the CLI and deletes the row after verifying (docs/etl.md).
export interface PendingWindow {
  from: string;
  to: string;
  holder: string;
  startedAt: string;
}

const PENDING_WINDOW_DDL = `CREATE TABLE IF NOT EXISTS refresh_pending_window (
  holder TEXT NOT NULL,
  window_from TEXT NOT NULL,
  window_to TEXT NOT NULL,
  started_at TEXT NOT NULL,
  PRIMARY KEY (holder, window_from)
)`;

function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Every window an earlier run started and never settled, oldest first; [] when none. */
export async function pendingWindows(db: D1Database): Promise<PendingWindow[]> {
  const present = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'refresh_pending_window'",
    )
    .first<{ name: string }>();
  if (!present) return [];
  const rows = await db
    .prepare(
      'SELECT window_from, window_to, holder, started_at FROM refresh_pending_window ORDER BY window_from, holder',
    )
    .all<{ window_from: string; window_to: string; holder: string; started_at: string }>();
  return rows.results.map((r) => ({
    from: r.window_from,
    to: r.window_to,
    holder: r.holder,
    startedAt: r.started_at,
  }));
}

// Record the exact coverage this run is about to apply. Keyed by (holder, from): a retried step
// re-records the same promise, never a second one.
export async function recordPendingWindow(
  db: D1Database,
  holder: string,
  from: string,
  to: string,
  now: Date = new Date(),
): Promise<void> {
  await db.batch([
    db.prepare(PENDING_WINDOW_DDL),
    db
      .prepare(
        `INSERT INTO refresh_pending_window (holder, window_from, window_to, started_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(holder, window_from) DO UPDATE SET window_to = ?3, started_at = ?4`,
      )
      .bind(holder, from, to, now.toISOString()),
  ]);
}

/** The part(s) of [from, to] outside `covered` — zero, one or two intervals, in order. */
export function subtractCovered(
  window: { from: string; to: string },
  covered: { from: string; to: string },
): { from: string; to: string }[] {
  if (window.to < covered.from || window.from > covered.to) return [window]; // disjoint
  const out: { from: string; to: string }[] = [];
  if (window.from < covered.from) out.push({ from: window.from, to: shiftDay(covered.from, -1) });
  if (window.to > covered.to) out.push({ from: shiftDay(covered.to, 1), to: window.to });
  return out;
}

export interface SettledWindows {
  /** Promises (or parts of them) the covered range fulfilled. */
  settled: number;
  /** What is still outstanding after this run — empty when every promise was covered. */
  remaining: PendingWindow[];
}

// Only after the served gate passed: subtract the verified coverage from every promise. Each
// promise is settled in its OWN atomic batch (its delete and the re-insert of what remains commit
// together), so a promise is never half-settled — and the statement count per batch stays at three
// no matter how many promises piled up, well inside D1's per-call ceiling. A death between two
// promises leaves the rest to the next successful run, which subtracts the same coverage again.
export async function settlePendingWindows(
  db: D1Database,
  covered: { from: string; to: string },
  now: Date = new Date(),
  /**
   * Which promises this coverage may settle; the rest are left as they are and reported as
   * remaining. The Worker passes "own promise only" when the run saw no bucket at all — a window in
   * which the source answered nothing is no evidence that an EARLIER run's window has been re-applied.
   */
  eligible: (w: PendingWindow) => boolean = () => true,
): Promise<SettledWindows> {
  const before = await pendingWindows(db);
  const remaining: PendingWindow[] = [];
  let settled = 0;
  for (const w of before) {
    if (!eligible(w)) {
      remaining.push(w); // not this run's to settle
      continue;
    }
    const rest = subtractCovered(w, covered);
    if (rest.length === 1 && rest[0]!.from === w.from && rest[0]!.to === w.to) {
      remaining.push(w); // untouched: entirely outside the coverage
      continue;
    }
    const statements: D1PreparedStatement[] = [
      db
        .prepare('DELETE FROM refresh_pending_window WHERE holder = ?1 AND window_from = ?2')
        .bind(w.holder, w.from),
    ];
    for (const r of rest) {
      statements.push(
        db
          .prepare(
            `INSERT INTO refresh_pending_window (holder, window_from, window_to, started_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(holder, window_from) DO UPDATE SET window_to = ?3, started_at = ?4`,
          )
          .bind(w.holder, r.from, r.to, now.toISOString()),
      );
    }
    await db.batch(statements);
    settled += 1;
    for (const r of rest) {
      remaining.push({ from: r.from, to: r.to, holder: w.holder, startedAt: now.toISOString() });
    }
  }
  // Already in order: `before` is read ordered by start, and subtraction only ever yields pieces
  // inside their own promise, so the pieces of an earlier promise never start after a later one.
  return { settled, remaining };
}
