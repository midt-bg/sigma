// #135 — global (account-wide) BgGPT circuit-breaker check. Called from the assistant route ONLY on the
// paid path (a real generation), AFTER the dedup resolve so a cache HIT never counts against the budget —
// otherwise a viral report link (many users, same question, all served from cache for free) would trip the
// breaker and defeat the dedup lane. Mirrors the per-IP limiter's FAIL-CLOSED contract: in production, an
// unprovisioned or erroring breaker rejects the paid loop (503) rather than letting spend run unbounded; in
// dev/preview it degrades to a no-op so local work is not blocked.

import type { BgGptCircuitBreaker } from './assistant/bggpt-circuit-breaker';
import { rateLimitExceededResponse, rateLimitUnavailableResponse } from './rate-limit';

// User-facing 429 body — Bulgarian, consistent with the route's other error responses.
const GLOBAL_LIMIT_MESSAGE = 'Асистентът е временно претоварен. Опитайте отново след минута.';

/**
 * Consult the global breaker for one paid BgGPT turn. Returns `null` to proceed, a 429 when the
 * account-wide minute budget is spent (breaker open), or a fail-closed 503 in production when the breaker
 * binding is missing/errors. `isProd` gates the fail-closed behaviour (dev degrades to a no-op).
 */
export async function rateLimitBgGptGlobal(
  request: Request,
  breaker: DurableObjectNamespace<BgGptCircuitBreaker> | undefined,
  isProd: boolean,
): Promise<Response | null> {
  if (!breaker) {
    // No global cap ⇒ unbounded account spend across IPs. Refuse in prod rather than risk it.
    if (isProd) console.warn('[assistant] BGGPT_CIRCUIT_BREAKER binding missing — failing closed');
    return isProd ? rateLimitUnavailableResponse(request, isProd) : null;
  }
  try {
    const decision = await breaker.get(breaker.idFromName('global')).admit();
    if (decision.allowed) return null;
  } catch (error) {
    console.warn('[assistant] BGGPT_CIRCUIT_BREAKER error — failing closed in prod', error);
    return isProd ? rateLimitUnavailableResponse(request, isProd) : null;
  }
  return rateLimitExceededResponse(request, isProd, GLOBAL_LIMIT_MESSAGE);
}
