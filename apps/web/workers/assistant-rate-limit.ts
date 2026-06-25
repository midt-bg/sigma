import { normalizedPathname, rateLimitRequest } from './rate-limit';

interface AssistantRateLimitEnv {
  ASSISTANT_RATE_LIMITER?: RateLimit;
}

// Per-IP throttle in front of POST /assistant/chat (review #80): every call runs embeddings + the
// BgGPT agent loop, so it is far more expensive than a normal page. Mirrors the CSV/aggregation
// limiters, but FAILS CLOSED in production (the `failClosed` option below): if the limiter binding is
// unprovisioned or errors, the paid agent loop is rejected with a 503 rather than running unthrottled.
// In dev/preview it still degrades to a no-op. A global (account-wide) budget / circuit-breaker is a
// remaining launch-gate TODO: the `BGGPT_RATE_LIMIT_RPM` var is declared for it but is NOT yet read or
// enforced — only this per-IP limiter is active today.
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
    // User-facing 429 body — Bulgarian, consistent with the route's error responses (the only
    // English left is the shared infra-level fail-closed 503, see assistant-contracts.md §3).
    'Твърде много заявки към асистента. Опитай отново след малко.',
    'ASSISTANT_RATE_LIMITER',
    { failClosed: true }, // never run the paid agent loop unthrottled in production
  );
}

// A React Router resource route runs its `action` for EVERY mutation method (POST/PUT/PATCH/DELETE),
// not just POST — and assistant.chat exports only `action`, so a `PUT /assistant/chat` runs the full
// embeddings + BgGPT loop. Gating on `method === 'POST'` let those non-POST methods reach the paid loop
// completely unthrottled. Throttle any non-GET/HEAD request to the path instead (GET/HEAD hit no loader
// and 405 cheaply) so no method that triggers the action can bypass the limiter (review #80, follow-up).
function isAssistantRequest(request: Request): boolean {
  const method = request.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  return normalizedPathname(request) === '/assistant/chat';
}
