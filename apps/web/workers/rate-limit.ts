import { baseSecurityHeaders } from '../app/lib/security';

export const RATE_LIMIT_PERIOD_SECONDS = 60;
export const RATE_LIMIT_FALLBACK_KEY = 'unknown-client';

export function normalizedPathname(request: Request): string {
  const pathname = new URL(request.url).pathname;

  try {
    return decodeURIComponent(pathname).toLowerCase().replace(/\/+$/, '') || '/';
  } catch {
    return pathname.toLowerCase().replace(/\/+$/, '') || '/';
  }
}

export function rateLimitKey(request: Request): string {
  return request.headers.get('CF-Connecting-IP')?.trim() || RATE_LIMIT_FALLBACK_KEY;
}

export async function rateLimitRequest(
  request: Request,
  limiter: RateLimit | undefined,
  isProd: boolean,
  body: string,
  failClosed = false,
): Promise<Response | null> {
  // `failClosed` callers (expensive/paid endpoints) must NOT run unthrottled in production when the
  // limiter is unprovisioned or throws — reject with a 503 instead of silently allowing. Non-prod
  // (dev/preview, where the binding is routinely absent) still degrades to a no-op so local work is
  // not blocked (review #80). CSV/aggregation keep the default fail-open behaviour.
  const closed = failClosed && isProd;

  if (!limiter) return closed ? rateLimitUnavailableResponse(request, isProd) : null;

  try {
    const outcome = await limiter.limit({ key: rateLimitKey(request) });
    if (outcome.success) return null;
  } catch {
    return closed ? rateLimitUnavailableResponse(request, isProd) : null;
  }

  return rateLimitExceededResponse(request, isProd, body);
}

/** 503 for a fail-closed limiter whose binding is missing or errored — distinct from a 429 throttle. */
export function rateLimitUnavailableResponse(request: Request, isProd: boolean): Response {
  const headers = new Headers({ 'Retry-After': String(RATE_LIMIT_PERIOD_SECONDS) });
  if (request.method !== 'HEAD') headers.set('Content-Type', 'text/plain; charset=utf-8');
  for (const [key, value] of baseSecurityHeaders(isProd)) headers.set(key, value);

  return new Response(request.method === 'HEAD' ? null : 'Rate limiting unavailable', {
    status: 503,
    headers,
  });
}

export function rateLimitExceededResponse(
  request: Request,
  isProd: boolean,
  body: string,
): Response {
  const headers = new Headers({
    'Retry-After': String(RATE_LIMIT_PERIOD_SECONDS),
  });

  if (request.method !== 'HEAD') {
    headers.set('Content-Type', 'text/plain; charset=utf-8');
  }

  for (const [key, value] of baseSecurityHeaders(isProd)) headers.set(key, value);

  return new Response(request.method === 'HEAD' ? null : body, {
    status: 429,
    headers,
  });
}
