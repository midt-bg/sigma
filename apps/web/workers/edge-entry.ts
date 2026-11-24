// Cacheability requires an explicit, positive edge TTL. Privacy directives take precedence.
export function edgeTtl(headers: Headers): number {
  const policy = headers.get('Cache-Control') ?? '';
  if (/\b(?:private|no-store|no-cache)\b/i.test(policy)) return 0;
  const seconds = Number(/(?:^|,)\s*s-maxage=(\d+)\s*(?:,|$)/i.exec(policy)?.[1]);
  return Number.isSafeInteger(seconds) ? seconds : 0;
}

const ENTRY = 'X-Sigma-Cache-Entry';

// Keep the route's own Cache API TTL. Also age an entry from the start of the render so a delayed
// write cannot reset its freshness. The ID lets conditional and range lookups verify the same entry.
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
