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
const SCRATCH_TABLES = ['amendment_contract_resolve'] as const;

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
