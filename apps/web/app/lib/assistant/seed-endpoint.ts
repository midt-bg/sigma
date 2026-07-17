// Authorization for the one-shot schema-corpus seed endpoint (POST /assistant/reindex). That route
// (re)embeds the static data dictionary into the Vectorize `sigma-assistant` index via
// indexSchemaCorpus — an operator action that spends Workers AI embedding calls — so it is gated
// behind a high-entropy token and OFF by default: when ASSISTANT_SEED_TOKEN is unset the endpoint is
// indistinguishable from a route that does not exist (404), exposing no provisioning signal.
//
// Pure + binding-free so it is unit-testable in isolation; the route is a thin wrapper around it.

export type SeedAuth =
  | { status: 'unconfigured' } // no token provisioned → behave as if the route does not exist (404)
  | { status: 'forbidden' } //    token provisioned but the request's bearer is absent/wrong (403)
  | { status: 'ok' }; //          bearer matches the configured token → run the seed

/** Extract the bearer credential from an `Authorization` header. Returns '' when absent or malformed. */
export function bearerToken(header: string | null): string {
  if (!header) return '';
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : '';
}

/**
 * Constant-time-ish string compare. Avoids an early-exit on the first differing byte (which would leak
 * a matching prefix via response timing) and folds the length difference into the accumulator so an
 * obviously-wrong length still walks a fixed span. The token is high-entropy operator-set; this is
 * defense-in-depth around an already auth-gated, low-frequency endpoint.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i += 1) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/** Decide whether a seed request is authorized, given the configured token and the presented bearer. */
export function authorizeSeed(configured: string | undefined, presented: string): SeedAuth {
  if (!configured) return { status: 'unconfigured' };
  if (!presented || !timingSafeEqual(configured, presented)) return { status: 'forbidden' };
  return { status: 'ok' };
}
