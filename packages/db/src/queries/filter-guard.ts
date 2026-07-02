// Compile-time filter-coverage guard (issue #138 bug class).
//
// Every list+CSV route keeps a `*_FILTER_KEYS` array (`as const satisfies readonly (keyof Params)[]`)
// that feeds the cache signature and the csv-export cache classifier. The `satisfies` proves every
// listed key is a real param field; `assertCovers` proves the converse — every param field except
// sort/pagination is listed. Together they make drift impossible in either direction: a new filter
// cannot reach the query (you must add the field to read `p.x` in buildFilters) without also entering
// the FILTER_KEYS array, the cache signature and the classifier guard test.
//
// Residual gap (accepted): nothing forces the web-side URL parser (apps/web/app/lib/filters.ts) to
// parse a new key — list and CSV then both ignore it (still consistent), but the URL param is
// silently dead until the parser is extended.
//
// A future 4th list+CSV route gets the whole guarantee with one obvious call:
//
//   export const FOO_FILTER_KEYS = [...] as const satisfies readonly (keyof FooListParams)[];
//   assertCovers<FooListParams, typeof FOO_FILTER_KEYS>();

/** Param fields that are route/pagination state, never row filters. */
type NonFilterField = 'sort' | 'cursor' | 'pageSize';

/**
 * Compiles only when `Keys` covers every filter field of `Params` (all fields except
 * sort/cursor/pageSize). A missing key turns the rest parameter into a required tuple naming the
 * missing field(s), so the call site errors with the culprit spelled out. Erased at runtime (no-op).
 */
export function assertCovers<Params, Keys extends readonly (keyof Params)[]>(
  ..._missing: Exclude<keyof Params, Keys[number] | NonFilterField> extends never
    ? []
    : ['FILTER_KEYS is missing:', Exclude<keyof Params, Keys[number] | NonFilterField>]
): void {}
