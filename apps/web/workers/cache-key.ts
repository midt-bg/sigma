// The cache key is built from the response-affecting query params only (CWE-349, issue #56); the set is
// the shared source of truth in app/lib/query-params.ts (also used by withParams for links).
import { CANONICAL_QUERY_PARAMS, INTENTIONALLY_UNKEYED } from '../app/lib/query-params';

// Allow-list entries keyed AHEAD of their reader: params owned by another OPEN stacked/parallel PR
// whose route lands separately. The reverse drift guard ("no stale allow-list entries") skips
// exactly these, so a key nothing will ever read cannot hide here indefinitely — every entry must
// name its owning PR and is removed (from this set) the moment that PR's reader merges. Keep this
// set minimal.
export const RESERVED_CACHE_PARAMS = new Set<string>([
  'g', // #144 (feat/network-force-layout): /network reads ?g=1 for the graph-only re-centre fetch
]);

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

  for (const [key, value] of url.searchParams) {
    if (CANONICAL_QUERY_PARAMS.has(key)) params.append(key, value);
  }

  params.sort();
  params.set('_dt', deployTag);
  url.search = params.toString();

  return new Request(url.toString(), request);
}
