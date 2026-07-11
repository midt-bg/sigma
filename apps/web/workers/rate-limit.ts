import { baseSecurityHeaders } from '../app/lib/security';

export const RATE_LIMIT_PERIOD_SECONDS = 60;
export const RATE_LIMIT_FALLBACK_KEY = 'unknown-client';

export function normalizedPathname(request: Request): string {
  const pathname = new URL(request.url).pathname;

  // Build the transform once and apply it to whichever pathname survives decoding, so the strips
  // below can never be half-applied across the try/catch branches.
  //
  // - Collapse duplicate slashes BEFORE the equality check: `//assistant/chat` would otherwise slip
  //   the path match and bypass the only limiter on the paid endpoint if the router still routes it
  //   (review #80, ydimitrof). `/\/{2,}/` → single slash.
  // - Strip a trailing `.data` BEFORE the trailing-slash strip, mirroring RRv7's own
  //   `getNormalizedPath` (`pathname.replace(/\.data$/, "")`). With `ssr: true`, single-fetch serves
  //   every UI route's loader at BOTH `/<path>` and `/<path>.data` (the form in-app navigation uses),
  //   so the limiter must classify by the canonical route path RR resolves — otherwise every limiter
  //   is trivially bypassable via the `.data` suffix (`/search.data`, `/companies.data`, …). See #184.
  //   `/_root.data` → `/_root`, which is fine: no limiter targets the root loader, so no need to map
  //   it back to `/`. `react-router.config.ts` does NOT set `unstable_trailingSlashAwareDataRequests`,
  //   so only the default `<path>.data` form exists; if that flag is ever enabled, the `/_.data` /
  //   `/<path>/_.data` forms would also need stripping here.
  const normalize = (path: string): string =>
    path
      .toLowerCase()
      .replace(/\/{2,}/g, '/')
      .replace(/\.data$/, '')
      .replace(/\/+$/, '') || '/';

  try {
    return normalize(decodeURIComponent(pathname));
  } catch {
    return normalize(pathname);
  }
}

export function rateLimitKey(request: Request): string {
  return request.headers.get('CF-Connecting-IP')?.trim() || RATE_LIMIT_FALLBACK_KEY;
}

export interface RateLimitOptions {
  /**
   * Fail CLOSED in production: if the limiter binding is unprovisioned or throws, reject with a 503
   * instead of silently letting the request through. For expensive/paid endpoints (e.g. the assistant
   * agent loop). Omitted → fail OPEN, which is what CSV/aggregation/search rely on.
   */
  failClosed?: boolean;
}

export async function rateLimitRequest(
  request: Request,
  limiter: RateLimit | undefined,
  isProd: boolean,
  body: string,
  name: string,
  { failClosed = false }: RateLimitOptions = {},
): Promise<Response | null> {
  // The `failClosed` option lets expensive/paid endpoints reject rather than run unthrottled when the
  // limiter is unprovisioned or throws in production — a 503 instead of silently allowing. Non-prod
  // (dev/preview, where the binding is routinely absent) still degrades to a no-op so local work is
  // not blocked (review #80). CSV/aggregation/search keep the default fail-open behaviour. The degrade
  // is always logged — a missing binding once per isolate, a limiter error every time — so the
  // misconfiguration stays visible.
  const closed = failClosed && isProd;

  if (!limiter) {
    logRateLimitDegrade('missing_binding', name);
    return closed ? rateLimitUnavailableResponse(request, isProd) : null;
  }

  try {
    const outcome = await limiter.limit({ key: rateLimitKey(request) });
    if (outcome.success) return null;
  } catch (error) {
    logRateLimitDegrade('limiter_error', name, error);
    return closed ? rateLimitUnavailableResponse(request, isProd) : null;
  }

  return rateLimitExceededResponse(request, isProd, body);
}

// A missing binding is a constant for the isolate's lifetime, so log it once per limiter to surface
// the misconfiguration without flooding logs on every request; limiter throws are exceptional and
// logged each time. Structured single-line JSON, in the same shape as request-log.ts entries.
const loggedMissingBinding = new Set<string>();

function logRateLimitDegrade(
  event: 'missing_binding' | 'limiter_error',
  name: string,
  error?: unknown,
): void {
  try {
    if (event === 'missing_binding') {
      if (loggedMissingBinding.has(name)) return;
      loggedMissingBinding.add(name);
    }
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'warn',
        event: `rate_limit_${event}`,
        limiter: name,
        ...(error !== undefined ? { error: String(error) } : {}),
      }),
    );
  } catch {
    // Logging must not affect rate-limiting behaviour.
  }
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
