// Keep this allow-list in sync with query params consumed by apps/web/app/routes loaders.
export const CACHE_QUERY_PARAMS = new Set([
  'a', // /compare — entity A slug
  'authority',
  'b', // /compare — entity B slug
  'bidder',
  'by', // /overruns — sort dimension (absolute | percent)
  'center',
  'count',
  'cursor',
  'eu',
  'funding',
  'g',
  'kind',
  'metric', // /compare leaderboard dimension
  'p',
  'procedure',
  'q',
  'sector',
  'sort',
  'top',
  'type',
  'value',
  'year',
]);

export function cacheKey(request: Request, deployTag: string): Request {
  const url = new URL(request.url);
  const params = new URLSearchParams();

  try {
    url.pathname = decodeURIComponent(url.pathname);
  } catch {
    // Malformed percent-encoding should not break cache lookup; keep the raw path as the fallback.
  }

  for (const [key, value] of url.searchParams) {
    if (CACHE_QUERY_PARAMS.has(key)) params.append(key, value);
  }

  params.sort();
  params.set('_dt', deployTag);
  url.search = params.toString();

  return new Request(url.toString(), request);
}
