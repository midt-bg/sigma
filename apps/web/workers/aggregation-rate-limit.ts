import { normalizedPathname, rateLimitRequest } from './rate-limit';

interface AggregationRateLimitEnv {
  AGG_RATE_LIMITER?: RateLimit;
}

const AGGREGATION_PATHS = new Set(['/companies', '/authorities']);

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
    'Too many aggregation requests',
    'AGG_RATE_LIMITER',
  );
}

function isAggregationRequest(request: Request): boolean {
  return (
    (request.method === 'GET' || request.method === 'HEAD') &&
    AGGREGATION_PATHS.has(normalizedPathname(request))
  );
}
