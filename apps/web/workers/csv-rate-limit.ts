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
  // The single-fetch twin (`/contracts.csv.data`) would run the whole export and then die serialising the
  // stream after half a minute. Nothing links to it; it is refused before the router, as React Router
  // itself tells a data request (by the raw pathname).
  if (new URL(request.url).pathname.endsWith('.data'))
    return new Response(request.method === 'HEAD' ? null : 'Not Found', { status: 404 });

  return rateLimitRequest(
    request,
    env.CSV_RATE_LIMITER,
    isProd,
    'Твърде много изтегляния на CSV за кратко време. Опитай пак след минута.',
    'CSV_RATE_LIMITER',
  );
}

function isCsvRequest(request: Request): boolean {
  return (
    (request.method === 'GET' || request.method === 'HEAD') &&
    normalizedPathname(request).endsWith('.csv')
  );
}
