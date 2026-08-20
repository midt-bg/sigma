// ISO-week util for the weekly digest producer (#167A) — `apps/etl`'s Monday cron resolves "last
// week" (Mon..Sun, ISO-8601 week numbering `YYYY-Www`) from this module, not from `temporal.ts`'s
// `resolveTemporalContext` (that one parses relative Bulgarian phrases into half-open, date-only
// bounds for SQL filters — a different job). Reuses `isoWeekday`/`addDaysIso` from `./temporal`
// (exported there, alongside this module, in the package barrel) since both share the same
// Monday-anchored day arithmetic.

import { addDaysIso, isoWeekday, splitIso } from './temporal';

export interface IsoWeek {
  /** ISO-8601 week id, e.g. `2026-W28`. */
  iso: string;
  /** Monday of the week, `YYYY-MM-DD`. */
  mondayIso: string;
  /** Sunday of the week, `YYYY-MM-DD`. */
  sundayIso: string;
  /** Inclusive lower bound for a `signed_at` range scan, local wall-clock (no timezone suffix). */
  startTs: string;
  /** Inclusive upper bound for a `signed_at` range scan, local wall-clock (no timezone suffix). */
  endTs: string;
}

/**
 * The ISO week number (Mon=0-anchored) of `iso`, per ISO-8601: the week containing that date's
 * Thursday determines both the week number and the ISO year (which can differ from the calendar
 * year at Dec/Jan boundaries — e.g. 2025-12-29 is `2026-W01`, 2020-12-28 is `2020-W53`).
 */
function isoWeekNumber(iso: string): { isoYear: number; week: number } {
  const [y, m, d] = splitIso(iso);
  const thursday = new Date(Date.UTC(y, m - 1, d));
  thursday.setUTCDate(thursday.getUTCDate() - isoWeekday(iso) + 3);
  const isoYear = thursday.getUTCFullYear();

  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7; // Monday=0..Sunday=6
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4DayNum);

  const week = Math.round((thursday.getTime() - week1Monday.getTime()) / (7 * 86_400_000)) + 1;
  return { isoYear, week };
}

/** Build the full IsoWeek record from the week's Monday date (`YYYY-MM-DD`). Shared by priorIsoWeek
 *  (which derives the Monday from `now`) and isoWeekFromId (which derives it from a week id). */
function isoWeekFromMonday(mondayIso: string): IsoWeek {
  const sundayIso = addDaysIso(mondayIso, 6);
  const { isoYear, week } = isoWeekNumber(mondayIso);
  return {
    iso: `${isoYear}-W${String(week).padStart(2, '0')}`,
    mondayIso,
    sundayIso,
    startTs: `${mondayIso}T00:00:00`,
    endTs: `${sundayIso}T23:59:59`,
  };
}

/** Resolve the FULL Mon–Sun ISO week immediately before the one containing `now` (Europe/Sofia civil date). */
export function priorIsoWeek(now: Date): IsoWeek {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const todayIso = `${get('year')}-${String(get('month')).padStart(2, '0')}-${String(get('day')).padStart(2, '0')}`;

  const thisMondayIso = addDaysIso(todayIso, -isoWeekday(todayIso));
  const mondayIso = addDaysIso(thisMondayIso, -7);
  return isoWeekFromMonday(mondayIso);
}

/**
 * Resolve the FULL Mon–Sun ISO week for an explicit `YYYY-Www` id (e.g. `2026-W28`) — the inverse of
 * the `iso` field priorIsoWeek returns. Used by the on-demand digest trigger to target a specific week
 * for testing. Throws on a malformed id or an out-of-range week (e.g. `2026-W54`), caught by a
 * round-trip check: the Monday we compute must map back to the same id.
 */
export function isoWeekFromId(id: string): IsoWeek {
  const match = /^(\d{4})-W(\d{2})$/.exec(id);
  if (!match) throw new Error(`isoWeekFromId: not an ISO week id ('${id}')`);
  const isoYear = Number(match[1]);
  const week = Number(match[2]);

  // Monday of ISO week 1 is the Monday on/before Jan 4 (Jan 4 is always in ISO week 1); week N's
  // Monday is (N-1)*7 days later. UTC throughout — the wall-clock date is all that matters here.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7; // Monday=0..Sunday=6
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4DayNum + (week - 1) * 7);
  const mondayIso = monday.toISOString().slice(0, 10);

  const resolved = isoWeekFromMonday(mondayIso);
  if (resolved.iso !== id) throw new Error(`isoWeekFromId: '${id}' is not a valid ISO week`);
  return resolved;
}
