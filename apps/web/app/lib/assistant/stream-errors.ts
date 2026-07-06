// Maps a mid-stream model-loop failure to the user-facing Bulgarian line carried in the SSE `error`
// chunk. Server-side counterpart of assistant-dock/errors.ts, which classifies pre-stream HTTP
// statuses — a mid-generation failure arrives AFTER the response is already 200, so there is no
// status to map; only the thrown error object. The global BgGPT cap lives in AI Gateway and fires
// at model-call time (spec: ai-assistant-agent-team.md §4), so a 429 here means "shared quota
// exhausted mid-turn" and gets the distinct shed message; everything else stays generic so no
// provider/internal detail leaks to the user.

import { APICallError, RetryError } from 'ai';

/** Shed message for a mid-generation gateway 429 (spec: ai-assistant-agent-team.md §3). */
export const GATEWAY_OVERLOADED_MESSAGE = 'Системата е натоварена, опитай пак след малко.';

/** Generic mid-stream failure copy (contracts error matrix, 200-during-streaming row). */
export const STREAM_ERROR_MESSAGE = 'Асистентът временно не е достъпен. Опитай отново след малко.';

// isInstance() checks the SDK's Symbol.for marker, so a plain object spoofing the shape
// ({statusCode: 429}) never matches — and the check holds across duplicated provider versions.
const is429 = (error: unknown): boolean =>
  APICallError.isInstance(error) && error.statusCode === 429;

/**
 * True when the error is (or wraps) a provider/gateway HTTP 429. With maxRetries > 0 the SDK
 * exhausts retries and throws RetryError with the attempts in `errors` (lastError = final one);
 * a 429 on ANY attempt counts — the retry may die on a different error after the cap fired.
 */
export function isGatewayRateLimit(error: unknown): boolean {
  if (is429(error)) return true;
  if (RetryError.isInstance(error)) return is429(error.lastError) || error.errors.some(is429);
  return false;
}

/** Map any mid-stream error to its user-facing Bulgarian line (429 → shed, else generic). */
export function classifyStreamError(error: unknown): string {
  return isGatewayRateLimit(error) ? GATEWAY_OVERLOADED_MESSAGE : STREAM_ERROR_MESSAGE;
}
