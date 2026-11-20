// Query parameters that order or page a list without narrowing it. Anything else is a filter or a search.
const NON_FILTER_PARAMS = new Set(['sort', 'cursor', 'page']);

/** True when the list is the whole corpus: no filter or search is applied, so an empty page means that
 *  nothing is loaded, not that a filter matched nothing. */
export function isUnfiltered(params: URLSearchParams): boolean {
  for (const key of params.keys()) if (!NON_FILTER_PARAMS.has(key)) return false;
  return true;
}
