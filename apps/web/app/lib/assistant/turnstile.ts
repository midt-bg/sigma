// Cloudflare Turnstile edge gate for the assistant endpoints (spec §7 — pre-LLM launch gate).
//
// The dock renders the keyless/invisible Turnstile widget and sends its token on the request; here
// we verify that token server-side (Cloudflare siteverify) BEFORE any body buffering or paid
// model/D1 work, so a bot/CSRF flood can't start a turn.
//
// Graceful degradation only in LOCAL DEV: when `TURNSTILE_SECRET` is unset the gate is a NO-OP iff
// `!isProd`, so the assistant stays usable during `vite dev` without a secret — a deliberate launch-gate
// step (spec §8). CAVEAT — `isProd` is `import.meta.env.PROD`, a VITE BUILD CONSTANT, not a runtime
// environment: it is inlined `true` for EVERY production build, i.e. every `wrangler deploy` target
// (preview, staging AND production), and `false` only under local dev-mode builds. So a missing secret
// FAILS CLOSED (503) on ALL deployed environments, not just production — staging is treated as production
// for this gate. That is the intended posture (a forgotten/rotated secret must never silently disable the
// bot gate, mirroring the fail-closed rate limiters, bggpt-global-rate-limit.ts) — provision
// `TURNSTILE_SECRET` on any deployed env before enabling the assistant there. If a per-target runtime
// override is ever wanted, drive `isProd` off a stamped `ENVIRONMENT` binding instead of the build const
// (the app makes the same build-const choice for security headers at entry.server.tsx). Pairs with the
// client widget (sends the token header); ship both, then set the secret before flipping the assistant on.

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Header the client transport attaches the Turnstile token on (mirrors Cloudflare's field name).
export const TURNSTILE_TOKEN_HEADER = 'cf-turnstile-response';

export interface TurnstileEnv {
  TURNSTILE_SECRET?: string;
}

export interface TurnstileRejection {
  status: number;
  error: string;
}

interface SiteverifyResponse {
  success: boolean;
  'error-codes'?: string[];
}

/**
 * Verify a Turnstile token against Cloudflare siteverify. Any network/parse failure or a non-2xx
 * response is treated as NOT verified (fail closed).
 */
export async function verifyTurnstileToken(
  token: string,
  secret: string,
  remoteip?: string,
): Promise<boolean> {
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (remoteip) form.append('remoteip', remoteip);
  try {
    // Bound the siteverify round-trip: a hung Cloudflare endpoint must not stall the request to the
    // platform limit. A timeout aborts → throws → the catch fails closed (fast 403), same as any error.
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as SiteverifyResponse;
    return data.success === true;
  } catch {
    return false;
  }
}

/**
 * Gate an assistant request. Returns a rejection to send back, or `null` to proceed.
 * When `TURNSTILE_SECRET` is unset: no-op (null) only under local dev (`!isProd`), but FAIL-CLOSED (503)
 * on every deployed target (`isProd` — see the header: the build const is true for preview/staging/prod
 * alike) so a missing secret can't silently disable the bot gate. `isProd` is the app-wide
 * `import.meta.env.PROD` signal, passed by the chat route.
 */
export async function turnstileRejection(
  request: Request,
  env: TurnstileEnv,
  isProd: boolean,
): Promise<TurnstileRejection | null> {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) {
    // No secret: degrade to a no-op outside production (spec §7/§8). In production, fail closed — a
    // forgotten/rotated secret must not silently turn the gate off (cf. the fail-closed rate limiters).
    if (!isProd) return null;
    return {
      status: 503,
      error: 'защитата срещу ботове не е конфигурирана. Опитай отново по-късно.',
    };
  }

  const token = request.headers.get(TURNSTILE_TOKEN_HEADER);
  if (!token) {
    return {
      status: 403,
      error: 'изисква се потвърждение, че не си робот. Опресни страницата и опитай пак.',
    };
  }

  // Cloudflare sets `cf-connecting-ip` on the edge; passing it tightens the check (optional per Turnstile).
  const remoteip = request.headers.get('cf-connecting-ip') ?? undefined;
  const ok = await verifyTurnstileToken(token, secret, remoteip);
  if (!ok) {
    return {
      status: 403,
      error: 'проверката за сигурност не бе успешна. Опресни страницата и опитай пак.',
    };
  }
  return null;
}
