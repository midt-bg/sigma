import { normalizedPathname, rateLimitRequest } from './rate-limit';

interface AssistantRateLimitEnv {
  ASSISTANT_RATE_LIMITER?: RateLimit;
}

// Per-IP throttle in front of POST /assistant/chat (review #80): every call runs embeddings + the
// BgGPT agent loop, so it is far more expensive than a normal page. Mirrors the CSV/aggregation
// limiters, but FAILS CLOSED in production (the `true` below): if the limiter binding is unprovisioned
// or errors, the paid agent loop is rejected with a 503 rather than running unthrottled. In dev/preview
// it still degrades to a no-op. A global budget / circuit-breaker (BGGPT_RATE_LIMIT_RPM) is the
// remaining launch-gate layer.
export async function rateLimitAssistantRoute(
  request: Request,
  env: AssistantRateLimitEnv,
  isProd: boolean,
): Promise<Response | null> {
  if (!isAssistantRequest(request)) return null;

  return rateLimitRequest(
    request,
    env.ASSISTANT_RATE_LIMITER,
    isProd,
    'Too many assistant requests',
    'ASSISTANT_RATE_LIMITER',
    true, // fail closed: never run the paid agent loop unthrottled in production
  );
}

function isAssistantRequest(request: Request): boolean {
  return request.method === 'POST' && normalizedPathname(request) === '/assistant/chat';
}
