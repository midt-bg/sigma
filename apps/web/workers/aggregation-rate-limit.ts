import { normalizedPathname, rateLimitRequest } from './rate-limit';

interface AggregationRateLimitEnv {
  AGG_RATE_LIMITER?: RateLimit;
}

// The pages whose loaders scan or aggregate large tables. A cache HIT never gets here (app.ts checks the edge
// cache first), so this budget is spent only by misses — and a unique query string forces a miss every
// time. `/_root` is the home page's single-fetch twin (`/_root.data`).
const AGGREGATION_PATHS = new Set([
  '/',
  '/_root',
  '/companies',
  '/authorities',
  '/contracts',
  '/flows',
  '/network',
  '/map',
  '/trends',
  '/analytics',
  '/competition',
]);

export async function rateLimitAggregationRoute(
  request: Request,
  env: AggregationRateLimitEnv,
  isProd: boolean,
): Promise<Response | null> {
  if (!isAggregationRequest(request)) return null;

  return rateLimitRequest(
    request,
    env.AGG_RATE_LIMITER,
    isProd,
    'Твърде много отворени страници за кратко време. Опитай пак след минута.',
    'AGG_RATE_LIMITER',
  );
}

function isAggregationRequest(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const path = normalizedPathname(request);
  // A contract's page and its .json twin.
  return AGGREGATION_PATHS.has(path) || path.startsWith('/contracts/');
}
