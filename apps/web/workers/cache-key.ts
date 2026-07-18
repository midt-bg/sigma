// The cache key is built from the response-affecting query params only (CWE-349, issue #56); the set is
// the shared source of truth in app/lib/query-params.ts (also used by withParams for links).
import { CANONICAL_QUERY_PARAMS } from '../app/lib/query-params';

export function cacheKey(request: Request, deployTag: string): Request {
  const url = new URL(request.url);
  const params = new URLSearchParams();

  try {
    // Decoding collapses `%2F` → `/`, so the encoded 200-form of a contract URL (percent-encoded slug,
    // review #221/#213) and a bogus raw-slash 404-form share ONE cache key. This is safe only because
    // app.ts gates cache-put on `response.ok` — the 404 form is never stored, so it can't poison the
    // encoded entry. If that `response.ok` gate is ever removed, this collision brings back the #213
    // cache-poison 404 regression; key on the raw (still-encoded) pathname then instead.
    url.pathname = decodeURIComponent(url.pathname);
  } catch {
    // Malformed percent-encoding should not break cache lookup; keep the raw path as the fallback.
  }

  // Group before appending so repeatable params can be canonicalized per-key: `?cpv=A&cpv=B` and
  // `?cpv=B&cpv=A` select the identical logical set and must map to the same cache entry, not
  // fragment into two (a hand-built or bot-issued URL is enough to hit this even though the app's
  // own links always write cpv pre-sorted via hrefToggleCpv).
  const grouped = new Map<string, string[]>();
  for (const [key, value] of url.searchParams) {
    if (!CANONICAL_QUERY_PARAMS.has(key)) continue;
    const values = grouped.get(key) ?? [];
    values.push(value);
    grouped.set(key, values);
  }
  for (const [key, values] of grouped) {
    const ordered = key === 'cpv' ? [...values].sort() : values;
    for (const v of ordered) params.append(key, v);
  }

  params.sort();
  params.set('_dt', deployTag);
  url.search = params.toString();

  return new Request(url.toString(), request);
}
