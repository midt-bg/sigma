import { normalizedPathname, rateLimitRequest } from './rate-limit';

interface SearchRateLimitEnv {
  SEARCH_RATE_LIMITER?: RateLimit;
  SUGGEST_RATE_LIMITER?: RateLimit;
}

export async function rateLimitSearchRoute(
  request: Request,
  env: SearchRateLimitEnv,
  isProd: boolean,
): Promise<Response | null> {
  if (!isSearchRequest(request)) return null;

  // The search box asks /search/suggest at every settled pause while typing, so it spends a roomier budget
  // of its own instead of the /search page's. The box treats a refusal as no suggestions.
  const suggest = normalizedPathname(request) === '/search/suggest';
  return rateLimitRequest(
    request,
    suggest ? env.SUGGEST_RATE_LIMITER : env.SEARCH_RATE_LIMITER,
    isProd,
    'Твърде много търсения за кратко време. Опитай пак след минута.',
    suggest ? 'SUGGEST_RATE_LIMITER' : 'SEARCH_RATE_LIMITER',
  );
}

// Match /search and any sub-path so every FTS-backed search route is limited — covers #59's per-keystroke
// /search/suggest without hardcoding the other sub-paths.
function isSearchRequest(request: Request): boolean {
  const path = normalizedPathname(request);
  return (
    (request.method === 'GET' || request.method === 'HEAD') &&
    (path === '/search' || path.startsWith('/search/'))
  );
}
