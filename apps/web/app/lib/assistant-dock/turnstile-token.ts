// Bridge between the invisible Turnstile widget (useTurnstileGate) and the chat transport
// (classifyingFetch). The widget registers a token minter while mounted; the transport calls
// `nextTurnstileToken()` once per request and attaches the result as the `cf-turnstile-response`
// header. Execute-per-send: a fresh single-use token each time (Turnstile tokens are single-use and
// expire ~5 min). When no minter is registered (no TURNSTILE_SITE_KEY configured), it returns null and
// the header is simply omitted — the server gate is a no-op in that state anyway.

// Must match the header the server gate reads (turnstile.ts TURNSTILE_TOKEN_HEADER).
export const TURNSTILE_TOKEN_HEADER = 'cf-turnstile-response';

type TokenMinter = () => Promise<string | null>;

let minter: TokenMinter | null = null;

/** Registered by useTurnstileGate while the widget is mounted; pass null to clear on unmount. */
export function setTurnstileMinter(fn: TokenMinter | null): void {
  minter = fn;
}

/** A fresh Turnstile token for the next request, or null when the gate isn't active / on any failure. */
export async function nextTurnstileToken(): Promise<string | null> {
  if (!minter) return null;
  try {
    return await minter();
  } catch {
    return null;
  }
}

/** Merge the Turnstile token into a request's headers (any HeadersInit form) without mutating input. */
export function withTurnstileHeader(headers: HeadersInit | undefined, token: string): Headers {
  const merged = new Headers(headers);
  merged.set(TURNSTILE_TOKEN_HEADER, token);
  return merged;
}
