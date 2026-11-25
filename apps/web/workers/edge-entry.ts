// The longest route policy is six hours. This ceiling also bounds a failed withdrawal delete.
export const MAX_SERVING_MS = 6 * 60 * 60 * 1000;

// Cacheability requires an explicit, positive edge TTL. Privacy directives take precedence.
export function edgeTtl(headers: Headers): number {
  const policy = headers.get('Cache-Control') ?? '';
  if (/\b(?:private|no-store|no-cache)\b/i.test(policy)) return 0;
  const seconds = Number(/(?:^|,)\s*s-maxage=(\d+)\s*(?:,|$)/i.exec(policy)?.[1]);
  return Number.isSafeInteger(seconds) ? Math.min(seconds, MAX_SERVING_MS / 1000) : 0;
}

// What a page can be served without: today only the footer's coverage figures (app/root.tsx).
export type DegradedPart = 'footer';

// As long as a 503 asks a client to wait (Retry-After, app.ts): long enough to shield an overloaded
// D1 from the same page again, short enough that the full page is back soon after it recovers.
export const DEGRADED_TTL_SECONDS = 30;

// A page rendered without one of its parts is still worth serving, but never as the complete page
// for the route's whole lifetime. Only a 200 the route already lets the edge keep is shortened; any
// other response keeps its own policy. The header names the missing part, on a HIT as on a MISS.
export function degraded(response: Response, part: DegradedPart): Response {
  if (response.status !== 200) return response;
  const headers = new Headers(response.headers);
  headers.set('X-Sigma-Degraded', part);
  const ttl = edgeTtl(headers);
  if (ttl > 0)
    headers.set('Cache-Control', `public, s-maxage=${Math.min(ttl, DEGRADED_TTL_SECONDS)}`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const ENTRY = 'X-Sigma-Cache-Entry';

// Cache API storage TTL starts at insertion. The serving deadline starts at render time, so
// a delayed write cannot extend eligibility. The ID binds conditional and range lookups to a copy.
export function stamped(response: Response, expires: number): Response {
  const headers = new Headers(response.headers);
  headers.set(ENTRY, `${expires}:${crypto.randomUUID()}`);
  headers.set(
    'Cache-Control',
    headers
      .get('Cache-Control')!
      .split(',')
      .map((directive) => directive.trim())
      .filter((directive) => !/^stale-(?:while-revalidate|if-error)\b/i.test(directive))
      .join(', '),
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function entryId(headers: Headers): string | null {
  return headers.get(ENTRY);
}

export function isFresh(headers: Headers, now: number): boolean {
  const expires = Number(entryId(headers)?.split(':', 1)[0]);
  return Number.isFinite(expires) && now < expires;
}

export function unstamp(headers: Headers): void {
  headers.delete(ENTRY);
}
