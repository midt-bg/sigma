// AST-level read-only guard + scope/shape enforcement (spec §9.4) — the stronger layer that WRAPS the
// structural guard in sql-guard.ts. Regex/keyword blocklists are bypassable in principle; this PARSES
// the statement with node-sql-parser (SQLite grammar) and enforces, all FAIL-CLOSED:
//
//   1. exactly ONE read-only SELECT (incl. WITH…SELECT) — anything else, or an unparseable string, is
//      rejected (a query that cannot be *proven* read-only is never run);
//   2. table allowlist — only the documented data-dictionary tables; blocks `sqlite_master`/
//      `sqlite_schema`/`pragma_*` and any internal/undocumented table (review #80, schema enumeration);
//   3. no comma cross-joins (a Cartesian product a LIMIT cannot bound) and no `WITH RECURSIVE`
//      (unbounded recursion);
//   4. an AST-authoritative outer LIMIT — injected when absent. Unlike the regex in sql-guard, this is
//      not fooled by a string-literal `'LIMIT 1'` or a sub-query LIMIT (review #80).
//
// Deliberate tradeoff of failing closed: valid-but-unparsed SQLite is rejected too. node-sql-parser's
// SQLite grammar does not cover every construct (e.g. window functions without `PARTITION BY`), so
// those are refused and the model falls back to the canonical `ORDER BY … LIMIT` pattern. Security is
// preferred over breadth.
//
// Still open (tracked in the README roadmap): an unkillable per-query timeout and a §9.4 read-only D1
// data path (the binding handed to run_sql is read-write today). Imports the SQLite-only build to keep
// the Worker bundle small.

import { Parser, type AST } from 'node-sql-parser/build/sqlite';
import { enforceLimit, MAX_ROWS, type GuardResult } from './sql-guard';
import { TABLES } from './describe-schema';

const parser = new Parser();

/** Tables run_sql may read — the documented data dictionary (describe-schema.ts). */
export const ALLOWED_TABLES: ReadonlySet<string> = new Set(TABLES.map((t) => t.name.toLowerCase()));

const deny = (reason: string): GuardResult => ({ ok: false, reason });

// Loose view over the parsed statement — node-sql-parser's union types are awkward to narrow, and we
// only read a few discriminant fields.
type LooseSelect = {
  type?: string;
  from?: Array<{ join?: unknown } | null> | null;
  with?: Array<{ name?: { value?: string } } | null> | null;
  limit?: { value?: unknown[] } | null;
};

/**
 * Parse-verify and scope `sql`: assert a single read-only SELECT over allowlisted tables, no comma
 * cross-join / recursion, and a bounded outer LIMIT (injected when absent). Expects the de-commented,
 * single-statement SQL from `assertReadOnlySelect`; returns the limited SQL or a rejection so run_sql
 * composes the two layers (structural → AST) and rejects on the first failure.
 */
export function guardSelect(sql: string, maxRows = MAX_ROWS): GuardResult {
  // Recursive CTEs can loop unbounded; the parser exposes no reliable recursive flag, so refuse the
  // keyword up front (the structural layer has already stripped comments).
  if (/\bwith\s+recursive\b/iu.test(sql)) return deny('recursive queries are not allowed');

  let parsed: AST | AST[];
  try {
    parsed = parser.astify(sql);
  } catch {
    // Fail closed: if we cannot parse it, we cannot prove it is read-only.
    return deny('could not be parsed for read-only verification');
  }
  const statements = Array.isArray(parsed) ? parsed : [parsed];
  if (statements.length !== 1) return deny('only a single statement is allowed');
  const ast = statements[0] as unknown as LooseSelect;
  if (ast.type !== 'select')
    return deny(`only SELECT is allowed (found: ${ast.type ?? 'unknown'})`);

  // Reject comma cross-joins (a Cartesian product, e.g. FROM a, b, c — LIMIT cannot bound the scan).
  const from = Array.isArray(ast.from) ? ast.from : [];
  if (from.length > 1 && from.slice(1).some((f) => f && !f.join)) {
    return deny('comma cross-joins are not allowed; use explicit JOIN … ON');
  }

  // Positive table allowlist — excludes CTE names, which tableList also returns.
  const cteNames = new Set(
    (ast.with ?? []).map((w) => String(w?.name?.value ?? '').toLowerCase()).filter(Boolean),
  );
  for (const entry of parser.tableList(sql)) {
    const table = entry.split('::')[2]?.toLowerCase();
    if (!table || cteNames.has(table)) continue;
    if (!ALLOWED_TABLES.has(table)) return deny(`table not allowed: ${table}`);
  }

  // Bound the OUTER result with an AST-authoritative LIMIT (a string-literal/sub-query LIMIT does not
  // set ast.limit, so this is not fooled the way a regex is).
  const hasOuterLimit = Array.isArray(ast.limit?.value) && ast.limit.value.length > 0;
  const limited = hasOuterLimit
    ? enforceLimit(sql, maxRows)
    : `${sql.replace(/;?\s*$/u, '')} LIMIT ${maxRows}`;
  return { ok: true, sql: limited };
}
