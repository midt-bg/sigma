import { normalizedPathname, rateLimitRequest } from './rate-limit';

interface SearchRateLimitEnv {
  SEARCH_RATE_LIMITER?: RateLimit;
}

export async function rateLimitSearchRoute(
  request: Request,
  env: SearchRateLimitEnv,
  isProd: boolean,
): Promise<Response | null> {
  if (!isSearchRequest(request)) return null;

  return rateLimitRequest(
    request,
    env.SEARCH_RATE_LIMITER,
    isProd,
    'Too many search requests',
    'SEARCH_RATE_LIMITER',
  );
}

// Match /search and any sub-path (/search/suggest etc.) so every FTS-backed search route shares the
// limiter — covers #59's per-keystroke /search/suggest without hardcoding its exact path.
function isSearchRequest(request: Request): boolean {
  const path = normalizedPathname(request);
  return (
    (request.method === 'GET' || request.method === 'HEAD') &&
    (path === '/search' || path.startsWith('/search/'))
  );
}
