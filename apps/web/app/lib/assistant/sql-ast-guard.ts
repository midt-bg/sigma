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
type LimitNode = { seperator?: string; value?: unknown[] } | null | undefined;
type FromEntry = {
  table?: string | null; // a plain table reference
  join?: unknown; // join kind for entries after the first ('INNER JOIN', …)
  on?: unknown; // join condition; null for an (explicit) cross-join
  using?: unknown; // USING(...) join condition — the other bounded form
  expr?: { type?: string; ast?: unknown } | null; // sub-query ({ ast }) or table-valued fn ({ type:'function' })
} | null;
type LooseSelect = {
  type?: string;
  columns?: Array<{ as?: string | null; expr?: { column?: string } | null } | null> | null;
  from?: FromEntry[] | null;
  with?: Array<{ name?: { value?: string } } | null> | null;
  limit?: LimitNode;
  _next?: LooseSelect | null; // compound (UNION/INTERSECT/EXCEPT) continuation
};

// Reject duplicate output column names. D1's `.all()` returns row OBJECTS keyed by column name, so two
// columns with the same output name (`SELECT t.id, c.id`) collapse to one — silently dropping a column
// from the model's view and from report binding (review #80). Ask the model to alias them. `*` is opaque
// (no schema to expand it here) so it is left to the binding layer.
function denyDuplicateColumns(ast: LooseSelect): string | null {
  const cols = Array.isArray(ast.columns) ? ast.columns : null;
  if (!cols) return null;
  const seen = new Set<string>();
  for (const c of cols) {
    const name = String(c?.as ?? c?.expr?.column ?? '').toLowerCase();
    if (!name || name === '*') continue;
    if (seen.has(name))
      return `duplicate output column "${name}"; give columns distinct AS aliases`;
    seen.add(name);
  }
  return null;
}

// A compound (UNION/INTERSECT/EXCEPT) hangs its trailing LIMIT off the LAST arm (the `_next` chain),
// not the top-level `ast.limit`. Walk to the last arm so the outer LIMIT is detected for compounds
// too — otherwise guardSelect would treat `… UNION … LIMIT 100000` as unbounded and append a SECOND
// LIMIT, which SQLite rejects as a syntax error (review #80).
function outerLimit(ast: LooseSelect): LimitNode {
  let node: LooseSelect = ast;
  while (node._next) node = node._next;
  return node.limit ?? ast.limit;
}

// Positive table allowlist with LEXICAL CTE scoping. Every plain-table FROM reference must be either an
// allowlisted table or a CTE that is IN SCOPE at that reference. A CTE is in scope for the query that
// declares it (its WITH) and that query's descendants — NOT for sibling or unrelated queries (SQLite
// scopes CTEs lexically). A flat, global CTE-name set (the previous approach) was UNSOUND: a throwaway
// CTE named `sqlite_master` declared inside an unrelated sub-query would exempt the REAL outer
// `FROM sqlite_master` from the check — a schema-enumeration bypass (review #80). Returns the first
// disallowed table, or null. The parsed AST is a finite tree, so the walk terminates.
function denyDisallowedTable(node: unknown, cteScope: ReadonlySet<string>): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = denyDisallowedTable(item, cteScope);
      if (r) return r;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  // CTEs declared on THIS node extend the scope for it and all its descendants (incl. sibling CTE bodies).
  let scope = cteScope;
  if (Array.isArray(obj.with)) {
    const next = new Set(cteScope);
    for (const cte of obj.with) {
      const name = (cte as { name?: { value?: string } } | null)?.name?.value;
      if (name) next.add(String(name).toLowerCase());
    }
    scope = next;
  }
  if (Array.isArray(obj.from)) {
    for (const f of obj.from as FromEntry[]) {
      if (f && typeof f.table === 'string' && f.table.length > 0) {
        const table = f.table.toLowerCase();
        if (!scope.has(table) && !ALLOWED_TABLES.has(table)) return `table not allowed: ${f.table}`;
      }
    }
  }
  for (const key of Object.keys(obj)) {
    const r = denyDisallowedTable(obj[key], scope);
    if (r) return r;
  }
  return null;
}

// Validate every FROM source in the statement at ANY nesting depth. A table-valued function or an
// ON-less cross-join tucked inside a sub-query (`FROM (SELECT … FROM json_each(…)) x`) or a WHERE-IN
// sub-select is the same row-amplification vector as one at the top level — and `parser.tableList()`
// is blind to TVFs (it returns [] for the function form), so the allowlist never sees them (review #80,
// ydimitrof H1). Returns a deny reason for the first bad source, or null. The AST is a finite tree.
function denyBadFromSource(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = denyBadFromSource(item);
      if (r) return r;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  const from = Array.isArray(obj.from) ? (obj.from as FromEntry[]) : null;
  if (from) {
    for (let i = 0; i < from.length; i++) {
      const f = from[i];
      if (!f) continue;
      // Only plain tables and sub-queries are allowed. A table-valued function (json_each, json_tree,
      // generate_series, pragma_*) is `{ expr: { type: 'function' } }` — neither a table nor a sub-query.
      const isTable = typeof f.table === 'string' && f.table.length > 0;
      const isSubquery = !!(f.expr && typeof f.expr === 'object' && f.expr.ast);
      if (!isTable && !isSubquery) return 'table-valued functions are not allowed in FROM';
      // Entries after the first must be an explicit JOIN carrying an ON/USING — a missing join is a
      // comma cross-join, an ON/USING-less JOIN is an explicit cross-join; both are Cartesian products.
      if (i > 0) {
        if (!f.join) return 'comma cross-joins are not allowed; use explicit JOIN … ON';
        if (f.on == null && f.using == null) {
          return 'JOIN without an ON/USING condition is a cross-join; add a join condition';
        }
      }
    }
  }
  for (const key of Object.keys(obj)) {
    const r = denyBadFromSource(obj[key]);
    if (r) return r;
  }
  return null;
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

  const dupCol = denyDuplicateColumns(ast);
  if (dupCol) return deny(dupCol);

  // Every FROM source must be a plain table or a sub-query, at ANY nesting depth — fail closed on
  // anything else. This blocks table-valued functions (`pragma_table_info(…)`, `json_each(…)`,
  // `json_tree(…)`, `generate_series(…)`) — invisible to parser.tableList() (it returns [] for the
  // function form) — and comma/ON-less cross-joins, INCLUDING ones tucked inside a sub-query or a
  // WHERE-IN sub-select, which the earlier top-level-only check missed (review #80, ydimitrof H1).
  const badFrom = denyBadFromSource(ast);
  if (badFrom) return deny(badFrom);

  // Positive table allowlist with lexical CTE scoping (see denyDisallowedTable): a real disallowed
  // table cannot be smuggled past the check by an out-of-scope CTE of the same name (review #80).
  const badTable = denyDisallowedTable(ast, new Set<string>());
  if (badTable) return deny(badTable);

  // Bound the OUTER result with an AST-authoritative LIMIT. The SQLite `LIMIT offset, count` COMMA form
  // fools the regex-based enforceLimit — it captures the offset (the first number), not the count, so a
  // query like `LIMIT 5, 10000` would pass through unclamped; reject the comma form outright. The
  // standard `LIMIT n OFFSET m` form parses to the same value.length but `seperator: 'offset'`, and is
  // SAFE: enforceLimit's regex captures the count `n` (OFFSET carries no `limit` keyword) and clamps it
  // while leaving OFFSET intact — so allow it (review #80, L1). Distinguish by `seperator`, NOT by
  // value.length (which is 2 for both forms). outerLimit() also covers compound selects, whose trailing
  // LIMIT lives on the last arm rather than the top-level node.
  const lim = outerLimit(ast);
  const limitValues = Array.isArray(lim?.value) ? lim.value : [];
  if (lim?.seperator === ',') {
    return deny('LIMIT offset, count is not allowed; use LIMIT n OFFSET m');
  }
  // Any explicit count (plain `LIMIT n`, or `LIMIT n OFFSET m`) routes through enforceLimit, which
  // clamps the count; only a fully absent LIMIT gets one appended.
  const hasOuterLimit = limitValues.length >= 1;
  const limited = hasOuterLimit
    ? enforceLimit(sql, maxRows)
    : `${sql.replace(/;?\s*$/u, '')} LIMIT ${maxRows}`;
  return { ok: true, sql: limited };
}
