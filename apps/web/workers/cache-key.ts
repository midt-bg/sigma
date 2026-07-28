// The cache key is built from the response-affecting query params only (CWE-349, issue #56); the set is
// the shared source of truth in app/lib/query-params.ts (also used by withParams for links).
import { CANONICAL_QUERY_PARAMS } from '../app/lib/query-params';

// Allow-list entries added ahead of their route — stacked-later work for /compare (`a`, `b`,
// `metric`), /overruns (`by`), and /price-anomaly (`cohort`). The cache-key.test.ts drift guard's
// stale-entry check treats these as expected-not-yet-consumed rather than flagging them, so a real
// drift (e.g. a `bidz` typo instead of `bids`) still surfaces while these documented, planned
// entries don't block unrelated PRs. When one of these routes ships and reads its param, it simply
// becomes "consumed" and this listing becomes a no-op for it — safe to leave or prune then.
export const PLANNED_QUERY_PARAMS = new Set<string>(['a', 'b', 'by', 'cohort', 'metric']);

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

  // The /trends CPV multi-select is a set, not a sequence — `cpv=A&cpv=B` and `cpv=B&cpv=A` select
  // the same group and must render the same SSR body. Canonicalize value order here (not just rely
  // on the UI writing pre-sorted hrefs) so distinct request orderings for an equal set never
  // fragment the edge cache into duplicate entries.
  const cpvValues = params.getAll('cpv').sort();
  if (cpvValues.length > 0) {
    params.delete('cpv');
    for (const v of cpvValues) params.append('cpv', v);
  }

  params.sort();
  params.set('_dt', deployTag);
  url.search = params.toString();

  return new Request(url.toString(), request);
}
