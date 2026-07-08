// A lookup table that is safe to index with UNTRUSTED keys (query params, etc.).
//
// Backed by a null-prototype object, so indexing with reserved names — `__proto__`, `toString`,
// `constructor`, `valueOf`, `hasOwnProperty`, … — returns `undefined` instead of an inherited
// Object.prototype member. That lets callers' existing `?? default` / `? :` / truthiness guards
// fall back correctly instead of resolving a truthy prototype member (which otherwise throws or, at
// the CSV export, silently produces an empty file). Use this for every `MAP[userInput]` lookup.
//
// `Object.values(map)` and `map[ownKey]` keep working unchanged; only the prototype chain is removed.
export const lookup = <T extends object>(entries: T): T =>
  Object.assign(Object.create(null), entries);
