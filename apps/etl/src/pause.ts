// The operator's hold on the scheduled starts (scripts/scheduled-pause.mjs, docs/deploy.md). One small
// object in the environment's declarations bucket: the bucket belongs to the environment, not to a slot, so
// a hold set before a blue/green switch still holds after it — the moment a freshly switched slot most needs
// to be watched before the cron writes to it. Only `scheduled()` reads it; a run an operator triggers by
// hand starts regardless.

/** Outside `declarations/corpus-v2/`, so neither the corpus proxy nor its expiry rules ever touch it. */
export const SCHEDULED_PAUSE_KEY = 'control/scheduled-pause.json';

export interface ScheduledPause {
  /** When the hold ends by itself, ISO-8601 UTC. A hold without one is not a hold. */
  until: string;
  reason: string;
}

export interface PauseState {
  pause: ScheduledPause | null;
  /** Why an object that is there was not taken as a hold. */
  problem?: string;
}

/**
 * The hold in force at `now`, or null. Best-effort, like the declarations state the handler reads beside
 * it: a bucket that does not answer, or an object that is not a well-formed hold, means „no hold" and is
 * named in `problem` — a hold that cannot be read must not freeze the site's data, which is exactly what
 * the mandatory expiry is there to prevent.
 */
export async function readScheduledPause(
  bucket: R2Bucket | undefined,
  now: Date,
): Promise<PauseState> {
  if (!bucket) return { pause: null };
  let text: string;
  try {
    const object = await bucket.get(SCHEDULED_PAUSE_KEY);
    if (!object) return { pause: null };
    text = await object.text();
  } catch (error) {
    return { pause: null, problem: `unreadable: ${String(error).slice(0, 200)}` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { pause: null, problem: 'not JSON' };
  }
  const { until, reason } = (value ?? {}) as Partial<Record<keyof ScheduledPause, unknown>>;
  if (typeof until !== 'string' || Number.isNaN(Date.parse(until)) || typeof reason !== 'string')
    return { pause: null, problem: 'needs a valid "until" and a "reason"' };
  return Date.parse(until) > now.getTime() ? { pause: { until, reason } } : { pause: null };
}
