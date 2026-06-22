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

function isSearchRequest(request: Request): boolean {
  return (
    (request.method === 'GET' || request.method === 'HEAD') &&
    normalizedPathname(request) === '/search'
  );
}
