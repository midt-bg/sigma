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

// `procedure_type != 'неизвестна'` / `<> ?` / `NOT IN ('неизвестна')` — exclude synthetic orphan tenders.
function matchesSyntheticExclusion(conjunct: unknown): boolean {
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
      label: "синтетични поръчки (procedure_type != 'неизвестна')",
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
