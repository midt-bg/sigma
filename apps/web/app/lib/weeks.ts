// Consumer-side helpers for the weekly digest (/weeks, /weeks/:iso). The StoredReport shape, its
// R2 read/write and the iso-week math live in `@sigma/report`; these are the digest-only bits: the
// deterministic key scheme and the R2 archive listing that backs the /weeks index.

import { date } from '@sigma/shared';

const WEEKS_PREFIX = 'weeks/';
// Producer-stamped `monday`/`sunday` customMetadata are raw `YYYY-MM-DD`; validate the shape before
// trusting a listing value so a malformed metadata string falls back to the iso rather than rendering junk.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Week number is 01–53 (ISO 8601 has no W00 and at most 53 weeks) — reject W00/W54–99 up front so a
// well-formed-but-impossible week 404s at validation rather than after a pointless R2 lookup.
const WEEK_NUM = '(?:0[1-9]|[1-4]\\d|5[0-3])';
const ISO_WEEK = new RegExp(`^\\d{4}-W${WEEK_NUM}$`);
const ISO_WEEK_KEY = new RegExp(`^weeks/(\\d{4}-W${WEEK_NUM})\\.json$`);

/** `2026-W25` → `weeks/2026-W25.json`, the immutable artifact's addressable key. */
export function isoWeekKey(iso: string): string {
  return `${WEEKS_PREFIX}${iso}.json`;
}

/** Reject a malformed `:iso` route param before any R2 read (→ 404). */
export function isValidIsoWeek(iso: string): boolean {
  return ISO_WEEK.test(iso);
}

/** One archive-index row for `/weeks`: the week, its Mon–Sun dates (for the human label) and its total
 *  spend (shown in the archive's total column), if published. `monday`/`sunday` are null on artifacts
 *  written before the producer began stamping them — the label then falls back to the iso. */
export interface WeekIndexEntry {
  iso: string;
  monday: string | null;
  sunday: string | null;
  totalEur: number | null;
}

/**
 * List the weeks that HAVE an artifact (spec §11: weeks without data simply do not appear). Reads the
 * total AND the Mon–Sun dates from each object's customMetadata so the archive needs no per-week fetch.
 * Newest first (ISO-week strings sort chronologically).
 */
export async function listStoredWeeks(bucket: R2Bucket): Promise<WeekIndexEntry[]> {
  const out: WeekIndexEntry[] = [];
  let cursor: string | undefined;
  // A mid-pagination R2 failure must not 500 the archive: log it and return what we have so far (a
  // partial-but-usable list beats an error page). The list is newest-first, so an early break still
  // surfaces the most recent weeks.
  try {
    do {
      const page = await bucket.list({ prefix: WEEKS_PREFIX, include: ['customMetadata'], cursor });
      for (const o of page.objects) {
        const m = ISO_WEEK_KEY.exec(o.key);
        if (!m) continue;
        const cm = o.customMetadata;
        const raw = cm?.totalEur;
        const total = raw != null && /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : null;
        const monday = cm?.monday != null && ISO_DATE.test(cm.monday) ? cm.monday : null;
        const sunday = cm?.sunday != null && ISO_DATE.test(cm.sunday) ? cm.sunday : null;
        out.push({ iso: m[1]!, monday, sunday, totalEur: total });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (error) {
    console.error('listStoredWeeks: R2 list failed, returning partial results', error);
  }
  return out.sort((a, b) => (a.iso < b.iso ? 1 : a.iso > b.iso ? -1 : 0));
}

/** Human label for a listed week: „13.07.2026 – 19.07.2026" when the Mon–Sun dates are present,
 *  else the raw iso id (older artifacts without the stamped dates). En-dash matches the report title. */
export function weekRangeLabel(entry: Pick<WeekIndexEntry, 'iso' | 'monday' | 'sunday'>): string {
  return entry.monday && entry.sunday ? `${date(entry.monday)} – ${date(entry.sunday)}` : entry.iso;
}
