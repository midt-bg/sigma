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
): Promise<Response | null> {
  if (!limiter) return null;

  try {
    const outcome = await limiter.limit({ key: rateLimitKey(request) });
    if (outcome.success) return null;
  } catch {
    return null;
  }

  return rateLimitExceededResponse(request, isProd, body);
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
