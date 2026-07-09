// The cache key is built from the response-affecting query params only (CWE-349, issue #56); the set is
// the shared source of truth in app/lib/query-params.ts (also used by withParams for links).
import { CANONICAL_QUERY_PARAMS } from '../app/lib/query-params';

export function cacheKey(request: Request, deployTag: string): Request {
  const url = new URL(request.url);
  const params = new URLSearchParams();

  try {
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
