// E3 — Guard G1 (step 2): the structural default-filters gate.
//
// `applyDefaultFilters` (workers/assistant/default-filters.ts) is the deterministic SOURCE of the safe
// contract defaults — it emits the exact predicate fragment the query layer appends and the callout
// surfaced to the reader. This gate is the VERIFIER for the path where the model wrote its own SQL: if
// the query reads the base `contracts` table it MUST already carry those defaults, otherwise live
// aggregates silently diverge from the rollups (amount_eur NULL rows leak in) or mix in synthetic
// orphan tenders.
//
// We verify STRUCTURALLY against the parsed AST, not by text presence. The previous version regex-matched
// the predicate text anywhere in the SQL, so a predicate placed in the projection
// (`SELECT (amount_eur IS NOT NULL) AS a …`), behind an `OR`, or inside a string literal slipped through
// unfiltered — yet `finalizeReport` then stamped a "rows were excluded" callout on a public report,
// asserting a filtering that never happened (review #12, blocking). Here each required default must be a
// TOP-LEVEL `AND` conjunct of the WHERE clause of every scope that reads base `contracts`.
//
// We stay in lock-step with the source: the required predicates are derived from `applyDefaultFilters()`
// (its descriptor flags and the synthetic sentinel param), not hard-coded independently.
//
// Rollup tables (authority_totals/sector_totals/company_totals/home_totals) already encode the filter
// in their materialization, so a query that never touches base `contracts` BYPASSES the gate.

import { applyDefaultFilters } from '../../../workers/assistant/default-filters';
import { parseSingleSelect, type LooseSelect } from './sql-ast-guard';

export type DefaultFiltersResult = { ok: true; callout: string[] } | { ok: false; reason: string };

// The synthetic-tender sentinel ('неизвестна'), read off the source so this gate tracks it.
const SYNTHETIC_SENTINEL = String(applyDefaultFilters().sql.params[0] ?? 'неизвестна');

type Node = Record<string, unknown>;
const isObj = (n: unknown): n is Node => !!n && typeof n === 'object';

// A `column_ref` for `col`, with or without an alias qualifier. node-sql-parser shape:
// `{ type:'column_ref', table:'c'|null, column:'amount_eur' }` (column is a plain lowercased-comparable string).
function isColumnRef(node: unknown, col: string): boolean {
  return (
    isObj(node) &&
    node.type === 'column_ref' &&
    typeof node.column === 'string' &&
    node.column.toLowerCase() === col
  );
}

// `<col> IS NOT NULL` → `{ type:'binary_expr', operator:'IS NOT', left:column_ref, right:{ type:'null' } }`.
function matchesAmountNotNull(conjunct: unknown): boolean {
  if (!isObj(conjunct) || conjunct.type !== 'binary_expr' || conjunct.operator !== 'IS NOT') {
    return false;
  }
  return (
    isColumnRef(conjunct.left, 'amount_eur') &&
    isObj(conjunct.right) &&
    conjunct.right.type === 'null'
  );
}

// The synthetic value to exclude: a bound `?` (parsed as `{ type:'origin', value:'?' }`) or the inlined
// `'неизвестна'` literal (`{ type:'single_quote_string', value:'неизвестна' }`).
function isSyntheticValue(node: unknown): boolean {
  if (!isObj(node)) return false;
  if (node.type === 'origin' && node.value === '?') return true;
  return typeof node.value === 'string' && node.value === SYNTHETIC_SENTINEL;
}

// `procedure_type != 'неизвестна'` / `<> ?` / `NOT IN ('неизвестна')` — backward-compat form.
function matchesProcedureTypeExclusion(conjunct: unknown): boolean {
  if (
    !isObj(conjunct) ||
    conjunct.type !== 'binary_expr' ||
    !isColumnRef(conjunct.left, 'procedure_type')
  ) {
    return false;
  }
  if (
    (conjunct.operator === '!=' || conjunct.operator === '<>') &&
    isSyntheticValue(conjunct.right)
  ) {
    return true;
  }
  if (
    conjunct.operator === 'NOT IN' &&
    isObj(conjunct.right) &&
    conjunct.right.type === 'expr_list'
  ) {
    const list = Array.isArray(conjunct.right.value) ? conjunct.right.value : [];
    return list.some(isSyntheticValue);
  }
  return false;
}

// `c.is_synthetic != 1` / `c.is_synthetic = 0` — preferred form (no tenders JOIN required).
function matchesIsSyntheticFlag(conjunct: unknown): boolean {
  if (!isObj(conjunct) || conjunct.type !== 'binary_expr') return false;
  if (!isColumnRef(conjunct.left, 'is_synthetic')) return false;
  const right = conjunct.right;
  if (!isObj(right) || right.type !== 'number') return false;
  const v = right.value;
  return (
    ((conjunct.operator === '!=' || conjunct.operator === '<>') && v === 1) ||
    (conjunct.operator === '=' && v === 0)
  );
}

// Exclude synthetic orphan contracts — accepts both the legacy procedure_type form and the new
// denormalized is_synthetic flag (set at ETL time, avoids a tenders JOIN in pure aggregates).
function matchesSyntheticExclusion(conjunct: unknown): boolean {
  return matchesProcedureTypeExclusion(conjunct) || matchesIsSyntheticFlag(conjunct);
}

// --- Conditional guard: a time-series that BUCKETS by signed_at (по година/месец) must bracket the date
// range. An UNBOUNDED year/month rollup lets stray out-of-coverage rows — source data-quality errors with
// a signed_at outside 2020..today (e.g. 2016, 2029) — fall into their own period buckets, so a
// „Разход по години" table (or the model's prose) shows years that aren't in the stated coverage. This
// fires ONLY when the query derives a period from signed_at in the projection/GROUP BY; plain non-temporal
// aggregates (totals, top-N) don't, so the totals⇄rollup reconciliation basis is untouched. Mirrors the
// site's own trend query (packages/db/src/queries/trend.ts): a series is bounded to
// `signed_at >= <start> AND signed_at <= date('now')`.
const DATE_BOUND_LABEL =
  "времеви обхват при серия по signed_at (напр. c.signed_at >= '2020-01-01' AND c.signed_at <= date('now'))";

// True if a `signed_at` column_ref appears anywhere in `node`, WITHOUT descending into a nested sub-select
// (its signed_at is its own scope, visited separately by forEachSelectScope).
function subtreeReferencesSignedAt(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(subtreeReferencesSignedAt);
  if (!isObj(node)) return false;
  if (node.type === 'select') return false;
  if (isColumnRef(node, 'signed_at')) return true;
  return Object.keys(node).some((k) => subtreeReferencesSignedAt(node[k]));
}

// A query „buckets by" signed_at when it derives a period from it in the PROJECTION (`substr(signed_at…)
// AS year`) or GROUP BY — the timeseries shape. signed_at used only in the WHERE is a plain date FILTER
// (already a range) and is not a bucket. A bare `c.signed_at` in the SELECT list is just display
// (e.g. a point-lookup returning the raw date value) — it is NOT a period derivation and must not
// trigger the date-window guard.
function projectionDerivesSignedAtPeriod(columns: unknown): boolean {
  if (!Array.isArray(columns)) return false;
  return columns.some((col) => {
    if (!isObj(col)) return false;
    // node-sql-parser wraps each SELECT item as `{ expr: <node>, as: <alias>|null }`.
    const expr = isObj(col.expr) ? col.expr : col;
    // A bare column_ref for signed_at is pure display — not a period derivation.
    if (isColumnRef(expr, 'signed_at')) return false;
    // signed_at appearing inside a function call (substr, strftime, …) derives a period bucket.
    return subtreeReferencesSignedAt(expr);
  });
}

function bucketsBySignedAt(sel: LooseSelect): boolean {
  const node = sel as unknown as Record<string, unknown>;
  return projectionDerivesSignedAtPeriod(node.columns) || subtreeReferencesSignedAt(node.groupby);
}

const UPPER_OPS = new Set(['<', '<=']);
const LOWER_OPS = new Set(['>', '>=']);

// Does `conjunct` bound signed_at at `end`? Accepts both operand orders (`signed_at <= x` and
// `x >= signed_at`) and BETWEEN (bounds both ends). The RHS value is NOT constrained — the canonical /
// temporal forms supply it (`date('now')`, an ISO literal); the gate only ensures the range is bracketed.
function boundsSignedAt(conjunct: unknown, end: 'upper' | 'lower'): boolean {
  if (!isObj(conjunct) || conjunct.type !== 'binary_expr') return false;
  const op = typeof conjunct.operator === 'string' ? conjunct.operator : '';
  const leftIsDate = isColumnRef(conjunct.left, 'signed_at');
  const rightIsDate = isColumnRef(conjunct.right, 'signed_at');
  if (!leftIsDate && !rightIsDate) return false;
  if (op.toUpperCase() === 'BETWEEN') return leftIsDate; // signed_at BETWEEN a AND b brackets both ends
  const want = end === 'upper' ? UPPER_OPS : LOWER_OPS;
  const flipped = end === 'upper' ? LOWER_OPS : UPPER_OPS; // reversed operands flip the sense
  return leftIsDate ? want.has(op) : flipped.has(op);
}

// A predicate that PINS signed_at (or its derived period `substr(signed_at,…)`) to a finite set — an
// equality, IN-list or BETWEEN — brackets both ends by construction (e.g. `substr(c.signed_at,1,4)='2023'`
// or `signed_at BETWEEN a AND b`). Excludes `IS NOT NULL` and the `GLOB '[0-9]…'` well-formedness check,
// which constrain shape, not the date value. NULL/`IS` operators and boolean joiners are not in the set.
const PIN_OPS = new Set(['=', 'IN', 'BETWEEN']);
function pinsSignedAtPeriod(conjunct: unknown): boolean {
  if (!isObj(conjunct) || conjunct.type !== 'binary_expr') return false;
  const op = typeof conjunct.operator === 'string' ? conjunct.operator.toUpperCase() : '';
  if (!PIN_OPS.has(op)) return false;
  // One side must reference signed_at directly or through substr/strftime; a sub-select's signed_at is
  // its own scope (subtreeReferencesSignedAt does not descend into it).
  return subtreeReferencesSignedAt(conjunct.left) || subtreeReferencesSignedAt(conjunct.right);
}

// A signed_at-bucketed series is adequately date-bounded when it carries EITHER a raw-column range that
// brackets both ends, OR a pinning equality/IN/BETWEEN on signed_at (raw or derived). Anything less (only
// `IS NOT NULL`, only a `GLOB` well-formedness check, or a single open-ended `>=`/`<=`) lets stray
// out-of-coverage rows leak into their own buckets.
function seriesIsDateBounded(conjuncts: unknown[]): boolean {
  if (conjuncts.some(pinsSignedAtPeriod)) return true;
  const hasUpper = conjuncts.some((c) => boundsSignedAt(c, 'upper'));
  const hasLower = conjuncts.some((c) => boundsSignedAt(c, 'lower'));
  return hasUpper && hasLower;
}

interface RequiredPredicate {
  /** Does this conjunct satisfy the required default? */
  matches: (conjunct: unknown) => boolean;
  /** Bulgarian label naming the default filter, used in the rejection reason. */
  label: string;
}

// Derive the required predicates once from the source descriptor so this gate tracks it: if the source
// stops excluding a class by default, we stop requiring it.
const REQUIRED: RequiredPredicate[] = (() => {
  const { descriptor } = applyDefaultFilters();
  const reqs: RequiredPredicate[] = [];
  if (descriptor.excludeNullAmount) {
    reqs.push({
      matches: matchesAmountNotNull,
      label: 'канонична стойност (amount_eur IS NOT NULL)',
    });
  }
  if (descriptor.excludeSynthetic) {
    reqs.push({
      matches: matchesSyntheticExclusion,
      label: 'синтетични поръчки (c.is_synthetic != 1)',
    });
  }
  return reqs;
})();

// Flatten the top-level `AND` conjuncts of a WHERE tree, STOPPING at any non-AND node — so a predicate
// nested under an `OR` (or any other operator) is NOT treated as an enforced conjunct.
function flattenAndConjuncts(where: unknown, acc: unknown[]): void {
  if (!isObj(where)) return;
  if (where.type === 'binary_expr' && where.operator === 'AND') {
    flattenAndConjuncts(where.left, acc);
    flattenAndConjuncts(where.right, acc);
    return;
  }
  acc.push(where);
}

// Does this SELECT scope read the base `contracts` table directly in its own FROM (not a rollup, not
// only via a sub-query/CTE handled as its own scope)?
function readsBaseContracts(sel: LooseSelect): boolean {
  const from = Array.isArray(sel.from) ? sel.from : [];
  return from.some(
    (f) => !!f && typeof f.table === 'string' && f.table.toLowerCase() === 'contracts',
  );
}

// Visit every SELECT scope in the statement — the top-level query, compound (UNION/…) arms, sub-queries,
// and CTE bodies — so a base-`contracts` read at ANY depth is checked against its OWN WHERE.
function forEachSelectScope(node: unknown, visit: (sel: LooseSelect) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) forEachSelectScope(item, visit);
    return;
  }
  if (!isObj(node)) return;
  if (node.type === 'select') visit(node as LooseSelect);
  for (const key of Object.keys(node)) forEachSelectScope(node[key], visit);
}

/**
 * Verify a model-authored SQL query carries the default contract filters when it reads base
 * `contracts`. Pure; parses the SQL with the shared SQLite parser.
 *
 * - Not a single parseable SELECT (incl. empty/whitespace), or a rollup-only / non-contracts read →
 *   bypass: `{ ok: true, callout: [] }`. (run_sql's `guardSelect` runs BEFORE this gate and already
 *   fails closed on anything unparseable or non-SELECT, so an unparseable input never reaches execution.)
 * - Every base-`contracts` scope carries each required default as a top-level WHERE `AND` conjunct →
 *   `{ ok: true, callout }` where `callout` is the standard `applyDefaultFilters()` callout.
 * - Any base-`contracts` scope missing a default → `{ ok: false, reason }`; `reason` is a lowercase
 *   fragment (no trailing period) naming the missing filter(s), e.g. interpolated by the caller as
 *   `Заявката е отхвърлена: ${reason}.`
 */
export function assertDefaultFilters(sql: string): DefaultFiltersResult {
  const ast = parseSingleSelect(sql);
  if (!ast) {
    // Nothing for this gate to enforce (non-SELECT / unparseable / empty) — see guardSelect note above.
    return { ok: true, callout: [] };
  }

  let sawBaseContracts = false;
  // Insertion order follows REQUIRED (amount_eur, then procedure_type) so the reason reads consistently.
  const missing = new Set<string>();
  forEachSelectScope(ast, (sel) => {
    if (!readsBaseContracts(sel)) return;
    sawBaseContracts = true;
    const conjuncts: unknown[] = [];
    flattenAndConjuncts(sel.where, conjuncts);
    for (const req of REQUIRED) {
      if (!conjuncts.some((c) => req.matches(c))) missing.add(req.label);
    }
    // A signed_at-bucketed series must bracket the date range, else stray out-of-coverage rows leak into
    // their own period buckets. Conditional — non-temporal reads bypass.
    if (bucketsBySignedAt(sel) && !seriesIsDateBounded(conjuncts)) {
      missing.add(DATE_BOUND_LABEL);
    }
  });

  if (!sawBaseContracts) {
    // No base contracts read (rollup-only / other tables) — nothing for this gate to enforce.
    return { ok: true, callout: [] };
  }
  if (missing.size > 0) {
    return {
      ok: false,
      reason: `липсва задължителен филтър по подразбиране: ${[...missing].join(', ')}`,
    };
  }
  return { ok: true, callout: applyDefaultFilters().callout };
}
