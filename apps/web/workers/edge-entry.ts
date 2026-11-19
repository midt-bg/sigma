// What the worker notes on a page it stores at the edge, and what those notes say about serving it.
//
// The Cache API only knows „stored" and „gone". A page is kept there well past the freshness its route
// asked for, so that a copy outlives a database that cannot answer; whether a kept copy may be served as
// it is, is decided here, from three headers written on the stored copy and removed on the way out.

const STORED_AT = 'X-Sigma-Stored-At'; // ms since the epoch, when the render began
const DATA = 'X-Sigma-Data'; // the data generation the page was rendered from, when one was known
const POLICY = 'X-Sigma-Cache-Control'; // the route's own Cache-Control, restored on the way out

/** A page whose data has not changed since it was rendered stays fresh this long, whatever its route asked. */
export const SAME_DATA_SECONDS = 21_600;

/** How long past its freshness the last good copy is kept, for when the page cannot be rendered. */
export const KEEP_SECONDS = 86_400;

function sMaxAge(policy: string | null): number | null {
  const match = /s-maxage=(\d+)/.exec(policy ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * The copy to store: the response with the worker's notes, kept by the cache for as long as it can be of
 * any use — its longest possible freshness plus the time it may stand in for a failed render.
 */
export function stamped(response: Response, now: number, generation: string | null): Response {
  const headers = new Headers(response.headers);
  const policy = headers.get('Cache-Control') ?? '';
  const kept = Math.max(sMaxAge(policy) ?? 0, SAME_DATA_SECONDS) + KEEP_SECONDS;
  headers.set(POLICY, policy);
  headers.set('Cache-Control', policy.replace(/s-maxage=\d+/, `s-maxage=${kept}`));
  headers.set(STORED_AT, String(now));
  if (generation !== null) headers.set(DATA, generation);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Whether a stored copy may be served as it is: within the freshness its route asked for, or — past that —
 * rendered from the data generation that is still the current one. An unknown generation proves nothing,
 * so then only the route's own freshness counts.
 */
export function isFresh(stored: Headers, now: number, generation: string | null): boolean {
  const at = Number(stored.get(STORED_AT) ?? NaN);
  const asked = sMaxAge(stored.get(POLICY));
  if (!Number.isFinite(at) || asked === null) return false;
  const age = (now - at) / 1000;
  if (age < asked) return true;
  return generation !== null && stored.get(DATA) === generation && age < SAME_DATA_SECONDS;
}

/**
 * Put the route's own policy back and drop the worker's notes, so nothing of them leaves the worker. The
 * notes are read from `from` when the headers at hand may have lost them (a 304 the cache answered).
 */
export function unstamp(headers: Headers, from: Headers = headers): void {
  const policy = from.get(POLICY);
  if (policy !== null) headers.set('Cache-Control', policy);
  for (const note of [STORED_AT, DATA, POLICY]) headers.delete(note);
}
