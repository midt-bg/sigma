// eop_fetch — hardened live query of the daily ЦАИС ЕОП open-data bucket (spec §3, hardened §9.7).
//
// SECURITY CORE (§9.7): the tool takes ONLY a validated date — never a model-supplied URL — and the
// base/host is fixed server-side, so there is no SSRF surface. The response is size-capped before it
// can reach the model context, and is labelled UNTRUSTED external content (same posture as the
// deferred web search): treat it as data, never as instructions.
//
// The day→file-URL mapping reuses the verified eopSource.ts helper. The network call is injected
// (`fetchImpl`) so validation/capping is unit-testable without hitting the live store.

import { eopSourceFiles } from '../eopSource';

export const EOP_EARLIEST_DAY = '2020-01-01'; // corpus coverage start (README/etl.md)
export const EOP_MAX_BYTES = 256 * 1024; // per-file byte cap on the untrusted response before it is parsed

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type DateValidation = { ok: true; day: string } | { ok: false; reason: string };

// EOP open-data buckets are keyed by the Europe/Sofia publication day (the file names embed the local
// date), so "today" must be the Sofia calendar day — UTC would reject a legitimately-current-day query
// in the post-midnight window before UTC rolls over (review #80). en-CA renders as YYYY-MM-DD.
function sofiaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(new Date());
}

/** Strictly validate a model-supplied day. ISO dates compare lexically, so string bounds are safe. */
export function validateEopDate(raw: string, today = sofiaToday()): DateValidation {
  // Match the WHOLE (trimmed) string, not a slice(0,10) prefix — otherwise `2023-05-01; DROP TABLE`
  // would validate as `2023-05-01`, smuggling a tail through for any caller that mishandles it (#80).
  const day = (raw ?? '').trim();
  if (!DAY_RE.test(day)) return { ok: false, reason: 'датата трябва да е във формат YYYY-MM-DD' };
  if (day < EOP_EARLIEST_DAY)
    return { ok: false, reason: `преди началото на обхвата (${EOP_EARLIEST_DAY})` };
  if (day > today) return { ok: false, reason: 'бъдеща дата' };
  return { ok: true, day };
}

export interface EopFile {
  label: string;
  rows?: unknown[];
  error?: string;
  truncated?: boolean;
}

export type FetchImpl = (
  url: string,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Fetch the day's open-data files with a hard per-file byte cap. The base/URLs come from the verified
 * server-side helper, never from the model. Returns labelled, parsed (untrusted) arrays or per-file
 * errors — a missing day yields 403s surfaced as errors, not a throw.
 */
export async function fetchEopDay(
  day: string,
  fetchImpl: FetchImpl,
  maxBytes = EOP_MAX_BYTES,
): Promise<EopFile[]> {
  const files = eopSourceFiles(day);
  return Promise.all(
    files.map(async ({ label, url }): Promise<EopFile> => {
      try {
        const res = await fetchImpl(url);
        if (!res.ok) return { label, error: `HTTP ${res.status}` };
        const body = await res.text();
        // Use UTF-8 byte count — body.length is UTF-16 code units, which undercount Cyrillic chars
        // by ~2× (each Cyrillic char is 2 UTF-8 bytes, 1 UTF-16 unit), so the cap fires at ~2×
        // the intended limit when using body.length directly (review #80, Bozhidar).
        const bodyBytes = new TextEncoder().encode(body).length;
        if (bodyBytes > maxBytes) {
          // Oversized untrusted file: do NOT parse it. Parsing the full body would defeat the cap
          // (the model would still see everything) and risks a memory blow-up on a huge JSON array.
          // Surface a soft error instead. (review #80 — the cap was previously a no-op.)
          return { label, error: 'отговорът е твърде голям (отрязан)', truncated: true };
        }
        try {
          const parsed = JSON.parse(body) as unknown;
          return { label, rows: Array.isArray(parsed) ? parsed : [parsed], truncated: false };
        } catch {
          return { label, error: 'невалиден JSON' };
        }
      } catch (e) {
        return { label, error: e instanceof Error ? e.message : 'fetch error' };
      }
    }),
  );
}
