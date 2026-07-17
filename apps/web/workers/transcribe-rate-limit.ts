import { normalizedPathname, rateLimitRequest } from './rate-limit';

interface TranscribeRateLimitEnv {
  TRANSCRIBE_RATE_LIMITER?: RateLimit;
}

// Per-IP throttle in front of POST /assistant/transcribe: every call runs a paid
// Workers AI Whisper transcription, so it is far more expensive than a normal page. Mirrors the assistant
// limiter and FAILS CLOSED in production (the `failClosed` option): if the binding is unprovisioned or
// errors, the paid inference is rejected with a 503 rather than running unthrottled. Dev/preview degrades
// to a no-op. A separate binding (not the chat limiter) so voice abuse can't drain the chat budget.
export async function rateLimitTranscribeRoute(
  request: Request,
  env: TranscribeRateLimitEnv,
  isProd: boolean,
): Promise<Response | null> {
  if (!isTranscribeRequest(request)) return null;

  return rateLimitRequest(
    request,
    env.TRANSCRIBE_RATE_LIMITER,
    isProd,
    'Твърде много заявки за транскрипция. Опитай отново след малко.',
    'TRANSCRIBE_RATE_LIMITER',
    { failClosed: true }, // never run paid transcription unthrottled in production
  );
}

// Throttle any non-GET/HEAD/OPTIONS request to the path: a React Router resource route runs its `action`
// for every mutation method (POST/PUT/PATCH/DELETE), so gating on POST alone would let those bypass.
function isTranscribeRequest(request: Request): boolean {
  const method = request.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  return normalizedPathname(request) === '/assistant/transcribe';
}
