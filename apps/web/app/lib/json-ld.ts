// Serialize a value for embedding inside an inline <script> (e.g. a JSON-LD data island). Plain
// JSON.stringify does NOT escape `<`, so a raw `</script>` in any string value would close the
// script element early and inject markup (stored XSS). Escaping `<` as \u003c is JSON-equivalent
// — JSON.parse returns the identical value — and closes that hole; the U+2028/U+2029 escapes keep
// the payload safe if a consumer evaluates it as JS rather than parsing it as JSON.
//
// `>` and `&` are deliberately NOT escaped: only `<` can start a markup/comment token in a script
// raw-text context (`</script`, `<!--`, `<script`), and this is not an HTML-attribute context, so
// `>`/`&` need no escaping — leaving them keeps the output byte-minimal and still valid JSON.
//
// This is the SINGLE shared implementation of the project's review standard (docs/review-security.md
// "Инжекции и валидация"): both root.tsx's JSON-LD island and routes/contract.json.tsx's response use
// it, so the two sinks cannot drift. Kept as defense-in-depth — today the only value reaching the
// JSON-LD is the request origin (which `new URL()` cannot make carry `</script>`), but this keeps the
// sink safe for any DB/user-derived field added later.
export function serializeJsonForScript(value: unknown): string {
  // JSON.stringify returns `undefined` (not a string) for `undefined`, a function, or a symbol \u2014 a
  // later `.replace` on it would throw. Emit valid JSON (`null`) instead, so the helper is safe for
  // any value even though today's callers always pass an object.
  const json = JSON.stringify(value);
  if (json === undefined) return 'null';
  return json
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
