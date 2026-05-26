// Run the scoped re-derive (scripts/refresh-slice.sql) inside D1. The SQL string is injected by the
// caller (the Worker imports it as a bundled text asset) so this stays a pure, testable function.

/** Split a multi-statement SQL script into individual statements. Strips `--` line comments, then
 *  splits only on a `;` that ends a line — so a `;` inside a string literal never splits a statement.
 *  (The refresh script also avoids `;`-in-literals, but this is the robust rule.) */
export function splitSqlStatements(sql: string): string[] {
  return (sql.replace(/--[^\n]*/g, '') + '\n')
    .split(/;[ \t]*\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Execute the refresh-slice script as one D1 batch (transactional: all-or-nothing), then return the
 * number of refresh-derived ('c:o:%') contracts now in the domain.
 */
export async function runRefreshSlice(db: D1Database, refreshSliceSql: string): Promise<number> {
  const statements = splitSqlStatements(refreshSliceSql);
  await db.batch(statements.map((s) => db.prepare(s)));
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM contracts WHERE id LIKE 'c:o:%'")
    .first<{ n: number }>();
  return row?.n ?? 0;
}
