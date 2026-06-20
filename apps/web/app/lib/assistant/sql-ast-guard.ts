// AST-level read-only guard (spec §9.4) — the stronger layer that WRAPS the structural guard in
// sql-guard.ts. Regex/keyword blocklists are bypassable in principle; this PARSES the statement with
// node-sql-parser (SQLite grammar) and asserts it is exactly ONE read-only SELECT (incl. WITH…SELECT).
//
// FAILS CLOSED: anything that does not parse, or parses to anything other than a single SELECT, is
// rejected — a query that cannot be *proven* read-only is never run. (review #80)
//
// Deliberate tradeoff of failing closed: valid-but-unparsed SQLite is rejected too. node-sql-parser's
// SQLite grammar does not cover every construct — notably window functions without a `PARTITION BY`
// clause — so those are refused, and the model falls back to the canonical `ORDER BY … LIMIT` ranking
// pattern (see describe-schema.ts). Security (no unproven statement runs) is preferred over breadth.
//
// Defence-in-depth still open: the D1 binding handed to run_sql is read-write today, so this guard is
// the gate. A separate read-only data path (spec §9.4) remains the belt-and-braces layer tracked in
// the README roadmap. Imports the SQLite-only build to keep the Worker bundle small.

import { Parser, type AST } from 'node-sql-parser/build/sqlite';
import type { GuardResult } from './sql-guard';

const parser = new Parser();

/**
 * Parse-verify that `sql` is a single read-only SELECT. Expects the de-commented, single-statement
 * SQL from `assertReadOnlySelect`, and returns the same `GuardResult` shape so run_sql composes the
 * two layers (structural → AST) and rejects on the first failure.
 */
export function assertReadOnlyAst(sql: string): GuardResult {
  let parsed: AST | AST[];
  try {
    parsed = parser.astify(sql);
  } catch {
    // Fail closed: if we cannot parse it, we cannot prove it is read-only.
    return { ok: false, reason: 'could not be parsed for read-only verification' };
  }
  const statements = Array.isArray(parsed) ? parsed : [parsed];
  if (statements.length !== 1) {
    return { ok: false, reason: 'only a single statement is allowed' };
  }
  const type = statements[0]?.type;
  if (type !== 'select') {
    return { ok: false, reason: `only SELECT is allowed (found: ${type ?? 'unknown'})` };
  }
  return { ok: true, sql };
}
