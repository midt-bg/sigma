// Which generation of the data the site is serving: the moment the procurement refresh last finished its
// totals, and the moment the declarations were last published. Two pages rendered under the same generation
// read the same data, so a stored one need not be rendered again (edge-entry.ts).
//
// Read from D1 at most once a minute per isolate, and never on a request's own time: a request takes what
// the isolate already knows and, when that is due, starts the next read behind itself. A read that fails
// leaves the last known value in place.
import { getDb } from '@sigma/db';

/** How often an isolate asks D1 for the generation. */
export const CHECK_MS = 60_000;

/**
 * How long after a change the generation counts as unknown. Both stamps are written near the end of a run,
 * not at its very end; a page rendered in that tail may hold half of the new data, and must not be kept as
 * a page of the new generation.
 */
export const SETTLE_MS = 30 * 60_000;

const QUERY = `SELECT (SELECT refreshed_at FROM home_totals WHERE id = 1) AS refreshed,
       (SELECT MAX(published_at) FROM rp_generation) AS published`;

interface Stamps {
  refreshed: string | null;
  published: string | null;
}

let known: Stamps | null = null;
let checkedAt = Number.NEGATIVE_INFINITY;

// `refreshed_at` is SQLite's datetime('now') — UTC without a zone; `published_at` is an ISO instant.
function instant(stamp: string): number {
  return Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(stamp) ? stamp : `${stamp.replace(' ', 'T')}Z`);
}

/** The generation these stamps name at `now`, or null while it is unknown or still settling. */
export function generationOf(stamps: Stamps | null, now: number): string | null {
  if (!stamps?.refreshed) return null;
  const changed = [stamps.refreshed, stamps.published]
    .filter((stamp): stamp is string => stamp !== null)
    .map(instant);
  if (changed.some((at) => !Number.isFinite(at) || now - at < SETTLE_MS)) return null;
  return `${stamps.refreshed}|${stamps.published ?? ''}`;
}

// Async, so that a worker without the binding fails the read like a busy database does, not the request.
async function read(env: { DB: D1Database }): Promise<Stamps | null> {
  return getDb(env).prepare(QUERY).first<Stamps>();
}

/** The current data generation as this isolate knows it; null when it does not, or cannot vouch for it. */
export function dataGeneration(
  env: { DB: D1Database },
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  now: number,
): string | null {
  if (now - checkedAt >= CHECK_MS) {
    checkedAt = now;
    ctx.waitUntil(
      read(env).then(
        (stamps) => {
          if (stamps) known = stamps;
        },
        // A busy database, or a database without one of the tables: what is known stays.
        () => {},
      ),
    );
  }
  return generationOf(known, now);
}

/** For tests: an isolate that has read nothing yet. */
export function forgetDataGeneration(): void {
  known = null;
  checkedAt = Number.NEGATIVE_INFINITY;
}
