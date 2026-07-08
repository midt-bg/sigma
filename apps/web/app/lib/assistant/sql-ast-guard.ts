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

// Function policy, enforced at the AST level by NORMALISED name (quoting-proof: node-sql-parser maps
// both `fn(…)` and `"fn"(…)` to the same name, so a double-quoted identifier — `"randomblob"(…)`, which
// slips the L1 word-boundary regex because the `"` breaks `\b` — is still caught here). TWO complementary
// checks (denyForbiddenFunction), primary first:
//
//   1. ALLOWED_FUNCTIONS — a POSITIVE allowlist and the FAIL-CLOSED DEFAULT. Any function whose name is
//      not listed is rejected, so a NEW SQLite aggregate/builder — the next `string_agg` (a 3.44 alias of
//      group_concat) or `json_pretty` (3.46) — is denied the moment D1's SQLite gains it, with NO code
//      change. This inverts the old denylist-only posture (review follow-up, ydimitrof/DiyanaDimitrova:
//      "every new aggregate is one release away from re-opening this hole"). The set is the documented
//      SQLite built-in scalar/aggregate/date/math/window functions that a read-only analytics query can
//      legitimately use; extend it here when a new legitimate need appears.
//   2. DANGEROUS_FUNCTIONS — a denylist retained as an EXPLICIT, tested record of the specifically-
//      dangerous names (memory-amplification aggregates/string-bombs, exfil encoders, load_extension) and
//      WHY, and as a backstop should one ever be mistakenly added to the allowlist. Redundant with (1) by
//      design (belt + suspenders); checked first so its specific reason wins.
//
// Classes of the dangerous set: memory-amplification DoW (materialise an unbounded value before capRows /
// RESULT_BYTE_CAP can measure it) — per-row string-bombs (randomblob/zeroblob/printf/format) and table-
// collapsing aggregates (group_concat/string_agg/json_group_array/json_group_object/json_pretty, which
// fold a whole table into one giant value that LIMIT caps by ROWS, not cell width); data exfil/encoding
// (quote/hex); RCE where extensions can load (load_extension). The per-row json builders/mutators are
// bounded but denied for family symmetry. `replace` is ALLOWED (single transliteration) and `||` is a
// legitimate single concatenation — but CHAINING either (inline or across a CTE graph) is a string-length
// bomb, bounded to one amplifying op per query by denyAmplifyingStringChain. `concat`/`concat_ws` are
// left OFF the allowlist for the same reason (they fail closed here).
const DANGEROUS_FUNCTIONS: ReadonlySet<string> = new Set([
  'load_extension',
  'randomblob',
  'zeroblob',
  'printf',
  'format',
  'group_concat',
  'string_agg',
  'quote',
  'hex',
  'json_group_array',
  'json_group_object',
  'json_object',
  'json_array',
  'json_quote',
  'json_pretty',
  'json_set',
  'json_insert',
  'json_replace',
  'json_patch',
  'json_remove',
]);

// Positive allowlist — the fail-closed default (see above). Documented SQLite built-ins a read-only
// analytics query legitimately uses. Grouped for maintenance; a name absent here is rejected.
const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  // aggregates that reduce to ONE scalar (not a table-collapsing string) — safe
  'count',
  'sum',
  'total',
  'avg',
  'min',
  'max',
  // core scalar
  'abs',
  'coalesce',
  'ifnull',
  'nullif',
  'iif',
  'length',
  'octet_length',
  'instr',
  'substr',
  'substring',
  'upper',
  'lower',
  'trim',
  'ltrim',
  'rtrim',
  'replace', // single op only — chaining (inline or cross-CTE) rejected by denyAmplifyingStringChain
  'char',
  'unicode',
  'unhex',
  'typeof',
  'sign',
  'round',
  'like',
  'glob',
  'likelihood',
  'likely',
  'unlikely',
  // NB: concat / concat_ws are deliberately NOT allowlisted — they are string-length AMPLIFIERS (a
  // CTE chain of `concat(v,v,…,v)` multiplies ×N/level, unbounded by LIMIT). No canonical query uses
  // them; a bare `||` is the only concatenation a read-only analytics query needs, and even that is
  // chain-bounded by denyAmplifyingStringChain. Leaving them off the allowlist fails them closed.
  'random',
  'changes',
  'total_changes',
  // date / time
  'date',
  'time',
  'datetime',
  'julianday',
  'unixepoch',
  'strftime',
  'timediff',
  // math (SQLite math extension, 3.35+)
  'acos',
  'acosh',
  'asin',
  'asinh',
  'atan',
  'atan2',
  'atanh',
  'ceil',
  'ceiling',
  'cos',
  'cosh',
  'degrees',
  'exp',
  'floor',
  'ln',
  'log',
  'log10',
  'log2',
  'mod',
  'pi',
  'pow',
  'power',
  'radians',
  'sin',
  'sinh',
  'sqrt',
  'tan',
  'tanh',
  'trunc',
  // window functions (ranking / offset) — do not collapse tables; safe
  'row_number',
  'rank',
  'dense_rank',
  'ntile',
  'lag',
  'lead',
  'first_value',
  'last_value',
  'nth_value',
  'percent_rank',
  'cume_dist',
]);

// The normalised, lowercased name of a function-call node, or null if `obj` is not one. A scalar call is
// `{ type:'function', name:{ name:[{ value }] } }` (quoted or not — same value); an aggregate is
// `{ type:'aggr_func', name:'GROUP_CONCAT' }` (a bare UPPERCASE string). A schema-qualified name is
// multi-part; the function is the last part.
function functionName(obj: Record<string, unknown>): string | null {
  if (obj.type === 'aggr_func' && typeof obj.name === 'string') return obj.name.toLowerCase();
  if (obj.type === 'function') {
    const parts = (obj.name as { name?: Array<{ value?: unknown }> } | null)?.name;
    if (Array.isArray(parts) && parts.length > 0) {
      const last = parts[parts.length - 1]?.value;
      if (typeof last === 'string') return last.toLowerCase();
    }
  }
  return null;
}

// Walk the AST and reject the first call to a forbidden function anywhere — SELECT list, WHERE, HAVING,
// a nested sub-query, a function argument. A name in DANGEROUS_FUNCTIONS is rejected with its specific
// reason; any other name NOT in ALLOWED_FUNCTIONS is rejected as the fail-closed default. The AST is a
// finite tree, so the walk terminates.
function denyForbiddenFunction(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = denyForbiddenFunction(item);
      if (r) return r;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  const fn = functionName(obj);
  if (fn) {
    if (DANGEROUS_FUNCTIONS.has(fn)) return `function not allowed: ${fn}`;
    if (!ALLOWED_FUNCTIONS.has(fn)) return `function not allowed: ${fn} (not in allowlist)`;
  }
  for (const key of Object.keys(obj)) {
    const r = denyForbiddenFunction(obj[key]);
    if (r) return r;
  }
  return null;
}

// String-length AMPLIFICATION guard. `replace(x, a, b)` and `||` concatenation are legitimate read-only
// string ops (Cyrillic↔Latin transliteration, joining a couple of columns), each bounded by the row size
// × the byte-capped literals. The DoW risk is not their COUNT but their COMPOUNDING — feeding an already-
// amplified value back into another amplifier grows length GEOMETRICALLY (×k per level), and `capRows` /
// `RESULT_BYTE_CAP` measure only AFTER the value materialises in-engine → Worker OOM via run_sql. Two
// shapes compound; everything else is bounded and must PASS (a flat `a || ' ' || b` sums a few byte-capped
// cells ONCE — not a bomb, and the old whole-query op-count over-blocked it):
//
//   (A) INLINE — a `replace()` fed an already-amplified argument: another `replace` nested in its args
//       (`replace(replace('A','A','AAAAAAAAAA')…)` → ×10 per level) OR a `||`/concat inside its args
//       (`replace(v,'x', v||v||…)`). `replace` re-scans and expands whatever it is given, so an amplified
//       input multiplies. A `||` whose operands are themselves amplifiers is NOT compounding — `||` is
//       associative, so `(a||b)||c` is just the bounded sum a+b+c; only `replace` re-expands its input.
//   (B) CROSS-SCOPE — amplifying ops (`replace` or `||`) appearing in ≥2 distinct SELECT scopes (a CTE
//       chain `WITH l1 AS (SELECT v||v||… FROM l0), l2 AS (… FROM l1)`, or a subquery feeding an outer
//       amplifier), where each scope reads the prior scope's single already-amplified cell and amplifies
//       again. A single scope's flat `v||v||…||v` is bounded (×N, N capped by the query length); the
//       geometric blow-up needs the value to survive a scope boundary and be re-amplified.
//
// Quoting-proof (functionName normalises `fn`/`"fn"`). `concat`/`concat_ws` never reach here — they are
// off ALLOWED_FUNCTIONS, so denyForbiddenFunction rejects them first.

// Does this subtree contain any string-length amplifier — a `replace()` call or a `||` operator?
function containsAmplifyingOp(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(containsAmplifyingOp);
  if (!node || typeof node !== 'object') return false;
  const obj = node as Record<string, unknown>;
  if (functionName(obj) === 'replace') return true;
  if (obj.type === 'binary_expr' && obj.operator === '||') return true;
  return Object.keys(obj).some((key) => containsAmplifyingOp(obj[key]));
}

// (A) A `replace()` whose ARGUMENTS transitively contain another amplifier (nested replace, or a `||`/
// concat feeding it) — the multiplicative inline bomb. The function-name identifier subtree is skipped so
// the replace never counts itself.
function denyCompoundingReplace(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = denyCompoundingReplace(item);
      if (r) return r;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  if (functionName(obj) === 'replace') {
    for (const key of Object.keys(obj)) {
      if (key === 'name') continue; // the identifier of THIS replace, not an argument
      if (containsAmplifyingOp(obj[key]))
        return 'function not allowed: nested/compounding replace() string-bomb';
    }
  }
  for (const key of Object.keys(obj)) {
    const r = denyCompoundingReplace(obj[key]);
    if (r) return r;
  }
  return null;
}

// Every SELECT node in the tree (main query, CTEs, sub-queries) — each is its own amplification scope.
function collectSelectNodes(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectSelectNodes(item, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (obj.type === 'select') out.push(obj);
  for (const key of Object.keys(obj)) collectSelectNodes(obj[key], out);
}

// Does THIS select scope contain an amplifier in its OWN expressions — not counting deeper nested selects
// (each is its own scope, counted separately by the caller)?
function scopeHasLocalAmplify(selectRoot: Record<string, unknown>): boolean {
  let found = false;
  const walk = (node: unknown, isRoot: boolean): void => {
    if (found || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, false);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (!isRoot && obj.type === 'select') return; // a nested scope — attributed to its own count
    if (functionName(obj) === 'replace' || (obj.type === 'binary_expr' && obj.operator === '||')) {
      found = true;
      return;
    }
    for (const key of Object.keys(obj)) walk(obj[key], false);
  };
  walk(selectRoot, true);
  return found;
}

function denyAmplifyingStringChain(ast: unknown): string | null {
  // (A) inline compounding — a replace re-expanding an already-amplified argument.
  const compounding = denyCompoundingReplace(ast);
  if (compounding) return compounding;
  // (B) cross-scope chaining — amplifying ops in ≥2 SELECT scopes feed level-to-level.
  const selects: Record<string, unknown>[] = [];
  collectSelectNodes(ast, selects);
  let amplifyingScopes = 0;
  for (const select of selects) if (scopeHasLocalAmplify(select)) amplifyingScopes++;
  return amplifyingScopes >= 2
    ? 'function not allowed: amplifying string chain (replace/|| across scopes — bomb)'
    : null;
}

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
export type LooseSelect = {
  type?: string;
  columns?: Array<{ as?: string | null; expr?: { column?: string } | null } | null> | null;
  from?: FromEntry[] | null;
  where?: unknown; // WHERE expression tree (binary_expr/column_ref/…) — read by the default-filters gate
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

  // Enforce the function policy by AST name (quoting-proof): reject the dangerous denylist AND anything
  // outside the positive allowlist (fail-closed default — the next new aggregate is denied without a code
  // change). See ALLOWED_FUNCTIONS / DANGEROUS_FUNCTIONS.
  const badFn = denyForbiddenFunction(ast);
  if (badFn) return deny(badFn);

  // String-length amplification is a memory-amplification bomb when it COMPOUNDS — a replace re-expanding
  // an already-amplified argument (inline) or amplifying ops chained across ≥2 SELECT scopes (a CTE
  // graph). A single op and flat `a || ' ' || b` concatenation are bounded and pass — see
  // denyAmplifyingStringChain (concat/concat_ws already fail the allowlist above).
  const amplify = denyAmplifyingStringChain(ast);
  if (amplify) return deny(amplify);

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

/**
 * Parse `sql` to a single SELECT AST for downstream structural checks (e.g. the default-filters gate),
 * or null if it is not exactly one parseable SELECT. Fail-soft by design: this is NOT a security gate —
 * `assertReadOnlySelect`/`guardSelect` run first in run_sql and already reject anything unparseable or
 * non-SELECT. Reuses the module parser so callers need not depend on node-sql-parser directly.
 */
export function parseSingleSelect(sql: string): LooseSelect | null {
  let parsed: AST | AST[];
  try {
    parsed = parser.astify(sql);
  } catch {
    return null;
  }
  const statements = Array.isArray(parsed) ? parsed : [parsed];
  if (statements.length !== 1) return null;
  const ast = statements[0] as unknown as LooseSelect;
  return ast.type === 'select' ? ast : null;
}
