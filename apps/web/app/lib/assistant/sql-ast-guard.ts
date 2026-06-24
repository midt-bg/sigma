// AST-level read-only guard + scope/shape enforcement (spec §9.4) — the stronger layer that WRAPS the
// structural guard in sql-guard.ts. Regex/keyword blocklists are bypassable in principle; this PARSES
// the statement with node-sql-parser (SQLite grammar) and enforces, all FAIL-CLOSED:
//
//   1. exactly ONE read-only SELECT (incl. WITH…SELECT) — anything else, or an unparseable string, is
//      rejected (a query that cannot be *proven* read-only is never run);
//   2. table allowlist — only the documented data-dictionary tables; blocks `sqlite_master`/
//      `sqlite_schema`/`pragma_*` and any internal/undocumented table (review #80, schema enumeration);
//   3. only plain tables and sub-queries in FROM — table-valued functions (`pragma_*`, `json_each`,
//      `json_tree`, `generate_series`…) are rejected: they expose schema / amplify rows and are
//      invisible to `tableList` (so the allowlist never sees them). No comma or ON-less cross-joins
//      (a Cartesian product a LIMIT cannot bound) and no `WITH RECURSIVE` (unbounded recursion);
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
type LimitNode = { value?: unknown[] } | null | undefined;
type FromEntry = {
  table?: string | null; // a plain table reference
  join?: unknown; // join kind for entries after the first ('INNER JOIN', …)
  on?: unknown; // join condition; null for an (explicit) cross-join
  using?: unknown; // USING(...) join condition — the other bounded form
  expr?: { type?: string; ast?: unknown } | null; // sub-query ({ ast }) or table-valued fn ({ type:'function' })
} | null;
type LooseSelect = {
  type?: string;
  from?: FromEntry[] | null;
  with?: Array<{ name?: { value?: string } } | null> | null;
  limit?: LimitNode;
  _next?: LooseSelect | null; // compound (UNION/INTERSECT/EXCEPT) continuation
};

// A compound (UNION/INTERSECT/EXCEPT) hangs its trailing LIMIT off the LAST arm (the `_next` chain),
// not the top-level `ast.limit`. Walk to the last arm so the outer LIMIT is detected for compounds
// too — otherwise guardSelect would treat `… UNION … LIMIT 100000` as unbounded and append a SECOND
// LIMIT, which SQLite rejects as a syntax error (review #80).
function outerLimit(ast: LooseSelect): LimitNode {
  let node: LooseSelect = ast;
  while (node._next) node = node._next;
  return node.limit ?? ast.limit;
}

/**
 * Parse-verify and scope `sql`: assert a single read-only SELECT over allowlisted tables (plain tables
 * / sub-queries only — no table-valued functions), no comma or ON-less cross-join, no recursion, and a
 * bounded outer LIMIT (injected when absent). Expects the de-commented, single-statement SQL from
 * `assertReadOnlySelect`; returns the limited SQL or a rejection so run_sql composes the two layers
 * (structural → AST) and rejects on the first failure.
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

  // Every FROM source must be a plain table or a sub-query — fail closed on anything else. This blocks
  // table-valued functions (`pragma_table_info(…)`, `json_each(…)`, `json_tree(…)`, `generate_series(…)`):
  // they expose schema or amplify rows, and parser.tableList() returns [] for the function form, so the
  // allowlist below never sees them (review #80). Sub-queries are allowed — their inner tables DO
  // surface in tableList and are allowlisted.
  const from = Array.isArray(ast.from) ? ast.from : [];
  for (let i = 0; i < from.length; i++) {
    const f = from[i];
    if (!f) continue;
    const isTable = typeof f.table === 'string' && f.table.length > 0;
    const isSubquery = !!(f.expr && typeof f.expr === 'object' && f.expr.ast);
    if (!isTable && !isSubquery) {
      return deny('table-valued functions are not allowed in FROM');
    }
    // Entries after the first must be an explicit JOIN carrying an ON/USING. A missing join is a comma
    // cross-join; a JOIN with neither ON nor USING is an explicit cross-join (incl. CROSS JOIN) — both
    // are Cartesian products a LIMIT cannot bound (review #80).
    if (i > 0) {
      if (!f.join) return deny('comma cross-joins are not allowed; use explicit JOIN … ON');
      if (f.on == null && f.using == null) {
        return deny('JOIN without an ON/USING condition is a cross-join; add a join condition');
      }
    }
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

  // Bound the OUTER result with an AST-authoritative LIMIT. The SQLite LIMIT offset, count form fools
  // the regex-based enforceLimit — it captures the offset (the first number), not the count, so a
  // query like `LIMIT 5, 10000` is passed through unclamped. Reject the comma form outright and ask
  // for the standard LIMIT n (OFFSET m) syntax (review #80, L1). outerLimit() also covers compound
  // selects, whose trailing LIMIT lives on the last arm rather than the top-level node.
  const lim = outerLimit(ast);
  const limitValues = Array.isArray(lim?.value) ? lim.value : [];
  if (limitValues.length > 1) {
    return deny('LIMIT offset, count is not allowed; use LIMIT n or LIMIT n OFFSET m');
  }
  const hasOuterLimit = limitValues.length === 1;
  const limited = hasOuterLimit
    ? enforceLimit(sql, maxRows)
    : `${sql.replace(/;?\s*$/u, '')} LIMIT ${maxRows}`;
  return { ok: true, sql: limited };
}
