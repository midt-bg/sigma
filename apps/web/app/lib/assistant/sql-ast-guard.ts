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
    // Count plain base tables in THIS FROM to reject a self-join that repeats one table ≥3× (`contracts
    // c1 JOIN contracts c2 … JOIN contracts c3 …`). Even with a valid ON, an equijoin on a low-cardinality
    // column then scans ~N³ rows the LIMIT cannot bound — a DoW the ≥2-qualifier ON check below can't see
    // (it has no column cardinality; verified ~843M scanned rows / 9 s on a 1.5k-row table). No legitimate
    // analytics query self-joins one table 3 times; a real 3-way join uses distinct tables. The 2× residual
    // is bounded by the per-turn rows-read budget (tools.ts, issue #122). (review #80, follow-up)
    const sameTable = new Map<string, number>();
    for (let i = 0; i < from.length; i++) {
      const f = from[i];
      if (!f) continue;
      // Only plain tables and sub-queries are allowed. A table-valued function (json_each, json_tree,
      // generate_series, pragma_*) is `{ expr: { type: 'function' } }` — neither a table nor a sub-query.
      const isTable = typeof f.table === 'string' && f.table.length > 0;
      const isSubquery = !!(f.expr && typeof f.expr === 'object' && f.expr.ast);
      if (!isTable && !isSubquery) return 'table-valued functions are not allowed in FROM';
      if (isTable) {
        const t = (f.table as string).toLowerCase();
        const count = (sameTable.get(t) ?? 0) + 1;
        if (count >= 3) {
          return `self-join repeats table "${f.table}" 3+ times; rewrite without the repeated self-join`;
        }
        sameTable.set(t, count);
      }
      // Entries after the first must be an explicit JOIN carrying an ON/USING — a missing join is a
      // comma cross-join, an ON/USING-less JOIN is an explicit cross-join; both are Cartesian products.
      if (i > 0) {
        if (!f.join) return 'comma cross-joins are not allowed; use explicit JOIN … ON';
        if (f.on == null && f.using == null) {
          return 'JOIN without an ON/USING condition is a cross-join; add a join condition';
        }
        // A non-null ON is not enough: `ON 1=1` / `ON true` (or a single-side predicate) is a tautology
        // that yields a full Cartesian product the LIMIT cannot bound — D1 bills on rows SCANNED, so one
        // such query can scan trillions of rows (DoW; review #80, ydimitrof C2). Require the ON to
        // actually connect two relations: ≥2 distinct table qualifiers among its column refs. USING(...)
        // connects by construction, so an ON-less USING join is left to the check above.
        if (f.on != null) {
          const quals = new Set<string>();
          collectColumnTables(f.on, quals);
          if (quals.size < 2) {
            return 'JOIN ON must connect both tables (e.g. a.id = b.id); a constant or single-side condition is a cross-join';
          }
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

// Collect the distinct, non-null table qualifiers of every column_ref in an expression subtree — used to
// check a JOIN ON actually connects two relations rather than being a constant/tautological cross-join.
function collectColumnTables(node: unknown, acc: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) collectColumnTables(x, acc);
    return;
  }
  const obj = node as Record<string, unknown>;
  // Do NOT descend into a sub-query: its column refs belong to its OWN scope and do not connect the
  // outer join. Counting them let `ON a.id = (SELECT z.id FROM other z)` masquerade as a two-table
  // connection (the qualifiers were {a, z}, size 2) while the joined tables share no predicate — a
  // Cartesian product, i.e. a structural bypass of the anti-tautology check (review #80, ultra).
  if (obj.type === 'select') return;
  if (obj.type === 'column_ref' && typeof obj.table === 'string' && obj.table.length > 0) {
    acc.add(obj.table.toLowerCase());
  }
  for (const k of Object.keys(obj)) collectColumnTables(obj[k], acc);
}

// True if a CTE body references its own name in any FROM — the defining trait of a RECURSIVE CTE (the
// name is only in scope inside the body for recursion). The parser parses `cte.stmt.ast` as the body.
function cteReferencesOwnName(body: unknown, name: string): boolean {
  let found = false;
  const walk = (node: unknown): void => {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.from)) {
      for (const f of obj.from as FromEntry[]) {
        if (f && typeof f.table === 'string' && f.table.toLowerCase() === name) {
          found = true;
          return;
        }
      }
    }
    for (const k of Object.keys(obj)) walk(obj[k]);
  };
  walk(body);
  return found;
}

// SQLite does NOT require the `RECURSIVE` keyword, so `WITH r AS (… FROM r) …` parses as a plain SELECT
// and the keyword regex misses it — yet it loops unbounded feeding an aggregate (LIMIT does not cut
// recursion; D1 has no cancellable timeout; the rows-read budget is checked only BEFORE the next query,
// so a hang never trips it — DoW, review #80, ydimitrof C1). Walk the AST and reject any CTE whose body
// references its own name. Returns the first offender, or null.
function denyRecursiveCte(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = denyRecursiveCte(item);
      if (r) return r;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.with)) {
    for (const cte of obj.with) {
      const c = cte as { name?: { value?: string }; stmt?: { ast?: unknown } } | null;
      const name = c?.name?.value?.toLowerCase();
      const body = c?.stmt?.ast;
      if (name && body && cteReferencesOwnName(body, name)) {
        return `recursive CTE "${c!.name!.value}" is not allowed`;
      }
    }
  }
  for (const k of Object.keys(obj)) {
    const r = denyRecursiveCte(obj[k]);
    if (r) return r;
  }
  return null;
}

// Read a LIMIT/OFFSET value node's number (handles `-1` whether parsed as a negative literal or a unary
// minus). NaN for a non-numeric node — those are left to enforceLimit/parse to handle.
function limitCount(v: unknown): number {
  if (v && typeof v === 'object') {
    const o = v as {
      type?: string;
      operator?: string;
      value?: unknown;
      expr?: { value?: unknown };
    };
    if (o.type === 'unary_expr' && o.operator === '-' && typeof o.expr?.value === 'number') {
      return -o.expr.value;
    }
    if (typeof o.value === 'number') return o.value;
  }
  return NaN;
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

  // A self-referencing CTE is recursive even without the `RECURSIVE` keyword — reject it (review #80, C1).
  const recursive = denyRecursiveCte(ast);
  if (recursive) return deny(recursive);

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
  // Reject a negative LIMIT/OFFSET: `LIMIT -1` means UNBOUNDED in SQLite, and the regex enforceLimit
  // misses the `-` and would append a second LIMIT that only fails by an accidental syntax error — make
  // the rejection explicit (review #80, ydimitrof).
  for (const v of limitValues) {
    const n = limitCount(v);
    if (n < 0) return deny('negative LIMIT/OFFSET is not allowed');
    // Require a plain non-negative INTEGER literal. node-sql-parser parses `1e9` as
    // { type: 'bigint', value: '1e9' } and `1.5` with a string value — limitCount returns NaN for both,
    // and enforceLimit's `\d+` regex cannot clamp them, so it would append a SECOND LIMIT
    // (`LIMIT 1e9 LIMIT 500`), a SQLite syntax error that only fails closed by accident. Reject so the AST
    // and the regex text models agree on the count (review #80, ydimitrof).
    if (!Number.isInteger(n)) return deny('LIMIT/OFFSET must be a plain non-negative integer');
  }
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
