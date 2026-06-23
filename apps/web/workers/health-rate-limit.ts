import { normalizedPathname, rateLimitRequest } from './rate-limit';

interface HealthRateLimitEnv {
  HEALTH_RATE_LIMITER?: RateLimit;
}

export async function rateLimitHealthRoute(
  request: Request,
  env: HealthRateLimitEnv,
  isProd: boolean,
): Promise<Response | null> {
  if (!isHealthRequest(request)) return null;

  return rateLimitRequest(
    request,
    env.HEALTH_RATE_LIMITER,
    isProd,
    'Too many health check requests',
    'HEALTH_RATE_LIMITER',
  );
}

function isHealthRequest(request: Request): boolean {
  return (
    (request.method === 'GET' || request.method === 'HEAD') &&
    normalizedPathname(request) === '/health'
  );
}
