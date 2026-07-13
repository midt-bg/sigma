// Pure helpers for FilterRail — no React, no DOM. Extracted so the selection derivations can be
// unit-tested in the node vitest environment (the component itself is native-form + uncontrolled
// inputs, so its behaviour is the browser's; only these derivations carry logic worth asserting).

import { CACHE_QUERY_PARAMS } from '../../workers/cache-key';

/** Selection state of a category's options against the group's currently-selected values. Drives the
 *  "select all" checkbox: `allSelected` → checked, `someSelected && !allSelected` → indeterminate. An
 *  empty category is never `allSelected` (nothing to select). Selected values outside the category are
 *  ignored. */
export function categorySelectionState(
  optionValues: string[],
  selected: Iterable<string>,
): { selectedCount: number; allSelected: boolean; someSelected: boolean } {
  const set = selected instanceof Set ? selected : new Set(selected);
  const selectedCount = optionValues.reduce((n, v) => (set.has(v) ? n + 1 : n), 0);
  return {
    selectedCount,
    allSelected: optionValues.length > 0 && selectedCount === optionValues.length,
    someSelected: selectedCount > 0,
  };
}

/** Every current URL param that must survive a filter submit but isn't a form control — e.g. `q`
 *  (search, owned by a separate SmartSearch form), the `authority`/`bidder` scope, `count`/`top`, etc.
 *  A native GET submit only serialises the form's own fields, so without these hidden inputs any such
 *  param is silently erased (the old JS path merged them via `withParams(sp, …)`). Excluded: the filter
 *  group keys (carried by their checkboxes/radios — re-emitting them would duplicate/re-add values),
 *  `sort` (its own dedicated hidden input), and `cursor`/`page` (intentionally dropped so the keyset
 *  resets to page 1). Repeated values are preserved.
 *
 *  SECURITY (CWE-349, #197/#228 review): only carry params on the cache allow-list. A hidden input is
 *  rendered into the SSR body, but `cache-key.ts` keys the cached response on `CACHE_QUERY_PARAMS`
 *  ONLY. Carrying an arbitrary `?zzz=<payload>` would inject unkeyed content into the body of a
 *  `publicCache`d list route — the poisoned render would be stored under the clean URL and served to
 *  everyone. Restricting to the allow-list guarantees every preserved param is part of the cache key,
 *  so a distinct value can never collapse onto another URL's entry. Unknown params are dropped (the
 *  loader ignores them anyway, so nothing that affects the response is lost). */
export function preservedParamInputs(
  sp: URLSearchParams,
  groupKeys: Iterable<string>,
): { key: string; value: string }[] {
  const owned = new Set<string>([...groupKeys, 'sort', 'cursor', 'page']);
  const out: { key: string; value: string }[] = [];
  for (const [key, value] of sp.entries()) {
    if (CACHE_QUERY_PARAMS.has(key) && !owned.has(key)) out.push({ key, value });
  }
  return out;
}

/** True for the „Всички" clear radios — a filter-group control (its `name` is a group key) submitting
 *  an empty value. Disabling these just before a GET submit keeps the applied URL canonical (no dangling
 *  `?value=&eu=` that fragments the edge cache). Scoping to group keys (not any empty-valued control) is
 *  deliberate: hidden non-filter fields like `sort` or a preserved `q` must never be dropped even if
 *  empty. Progressive — with JS off the handler never runs and the empty params are emitted but harmless
 *  (every loader treats an empty filter value as unset). */
export function shouldPruneField(
  field: { name: string; value: string },
  groupKeys: ReadonlySet<string>,
): boolean {
  return field.value === '' && groupKeys.has(field.name);
}

/** Query-string signature used to key the form so it remounts (re-applying `defaultChecked`) when the
 *  applied filter set changes. `cursor`/`page` (pagination) and `sort` (a view option, not a filter)
 *  are excluded so paging or re-sorting doesn't remount the form and collapse the visitor's `<details>`
 *  open/closed state and focus — none of them change which boxes are checked.
 *
 *  `.sort()` before `toString()` so the key is order-insensitive: the SAME filter set reached via a
 *  different param order (a shared link, a hand-edited URL, back/forward) yields the SAME key and does
 *  NOT remount the form — which is exactly what the key exists to avoid (#228 review). */
export function filterFormKey(sp: URLSearchParams): string {
  const next = new URLSearchParams(sp);
  next.delete('cursor');
  next.delete('page');
  next.delete('sort');
  next.sort();
  return next.toString();
}
