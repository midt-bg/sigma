// Serialize a value for embedding inside an inline <script> (e.g. a JSON-LD data island). Plain
// JSON.stringify does NOT escape `<`, so a raw `</script>` in any string value would close the
// script element early and inject markup (stored XSS). Escaping `<` as \u003c is JSON-equivalent
// — JSON.parse returns the identical value — and closes that hole; the U+2028/U+2029 escapes keep
// the payload safe if a consumer evaluates it as JS rather than parsing it as JSON.
//
// Mirrors the project's own review standard (docs/review-security.md "Инжекции и валидация") and the
// safeJson helper in routes/contract.json.tsx. Kept as defense-in-depth: today the only value that
// reaches root.tsx's JSON-LD is the request origin (which `new URL()` cannot make carry `</script>`),
// but this makes the sink safe for any DB/user-derived field added to the graph later.
export function jsonLdScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
