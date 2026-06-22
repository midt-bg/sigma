import { normalizedPathname, rateLimitRequest } from './rate-limit';

interface CsvRateLimitEnv {
  CSV_RATE_LIMITER?: RateLimit;
}

export async function rateLimitCsvExport(
  request: Request,
  env: CsvRateLimitEnv,
  isProd: boolean,
): Promise<Response | null> {
  if (!isCsvRequest(request)) return null;

  return rateLimitRequest(
    request,
    env.CSV_RATE_LIMITER,
    isProd,
    'Too many CSV export requests',
    'CSV_RATE_LIMITER',
  );
}

function isCsvRequest(request: Request): boolean {
  return (
    (request.method === 'GET' || request.method === 'HEAD') &&
    normalizedPathname(request).endsWith('.csv')
  );
}
