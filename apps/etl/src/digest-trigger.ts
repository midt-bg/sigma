// On-demand weekly-digest trigger (#167A) — an authenticated HTTP entry point for TESTING, so a
// digest can be generated immediately instead of waiting for the Monday cron. The ETL worker is
// otherwise cron-only (wrangler.toml: workers_dev=false, no route), so this surface is unreachable in
// production regardless; where it IS reachable (a preview env that opts in), it is gated in order:
//
//   1. fail-dark enable flag (DIGEST_TRIGGER_ENABLED) — off, or no token configured → 404, so the
//      endpoint's very existence is not probeable.
//   2. constant-time bearer-token check against the DIGEST_TRIGGER_TOKEN secret (the security
//      boundary — checked before method, so an unauthenticated caller never gets a method-specific
//      response that would reveal the route).
//   3. POST only (it generates + publishes an artifact — a state change).
//
// It is deliberately INDEPENDENT of the DIGEST_ENABLED cron kill switch: the point is to test the
// digest before opting the recurring cron in, so the trigger works with the cron still dark.

import { isoWeekFromId } from '@sigma/report';
import { digestEnabled, generateWeeklyDigest, type WeeklyDigestEnv } from './weekly-digest';

export interface DigestTriggerEnv extends WeeklyDigestEnv {
  /** Fail-dark enable flag for this endpoint (mirrors DIGEST_ENABLED's posture). Committed "false". */
  DIGEST_TRIGGER_ENABLED?: string;
  /** Bearer token the caller must present. A `wrangler secret`, never committed. Unset → endpoint 404s. */
  DIGEST_TRIGGER_TOKEN?: string;
}

/** Extract the `Authorization: Bearer <token>` value, or null. */
function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/**
 * Constant-time token comparison. Hashing both sides to a fixed-length SHA-256 digest first means the
 * byte-compare never short-circuits on length (a raw length check would leak the secret's length) and
 * runs in time independent of how many leading bytes happen to match.
 */
async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i]! ^ vb[i]!;
  return diff === 0;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * Handle a trigger request. Returns a JSON Response; the digest's real outcome (published / skipped +
 * reason) is in the structured logs and R2, same as the cron. Optional `?week=YYYY-Www` targets a
 * specific ISO week; omitted → the prior week, exactly like the cron.
 */
export async function handleDigestTrigger(
  request: Request,
  env: DigestTriggerEnv,
): Promise<Response> {
  // Gate 1 — enable flag AND a configured token. Either missing → 404 (indistinguishable from "no such
  // route"), so a disabled or half-configured deploy can never be driven or even detected. Reuses the
  // same fail-dark parser as the cron kill switch (digestEnabled), applied to this endpoint's own flag.
  const token = env.DIGEST_TRIGGER_TOKEN?.trim();
  if (!digestEnabled(env.DIGEST_TRIGGER_ENABLED) || !token) {
    return json({ error: 'not_found' }, 404);
  }

  // Gate 2 — authenticate (the security boundary) BEFORE the method check, so an unauthenticated
  // caller gets a uniform 401 regardless of method and never learns which methods the route accepts.
  const presented = bearerToken(request);
  if (!presented || !(await tokenMatches(presented, token))) {
    return json({ error: 'unauthorized' }, 401);
  }

  // Gate 3 — method (only authenticated callers reach here).
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  // Optional week target — validated for BOTH format and range up front (isoWeekFromId throws on a
  // malformed id like `2026W28` AND on an out-of-range week like `2026-W99`), so bad input is a 400
  // and never reaches generation.
  const week = new URL(request.url).searchParams.get('week');
  if (week !== null) {
    try {
      isoWeekFromId(week);
    } catch {
      return json({ error: 'bad_week', hint: 'expected a valid ISO week, e.g. 2026-W28' }, 400);
    }
  }

  try {
    await generateWeeklyDigest(env, week ? { targetIso: week } : {});
  } catch (error) {
    return json(
      { error: 'generate_failed', message: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
  return json({ ok: true, week: week ?? 'prior' }, 200);
}
