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

// DAY_RE only checks SHAPE — `2023-13-45` / `2023-02-30` match it but are not real days. Verify the
// parts round-trip through a UTC Date so a nonsense day is rejected up front rather than building a
// URL that just 404s against the open-data store (review #80).
function isRealCalendarDay(day: string): boolean {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Strictly validate a model-supplied day. ISO dates compare lexically, so string bounds are safe. */
export function validateEopDate(raw: string, today = sofiaToday()): DateValidation {
  // Match the WHOLE (trimmed) string, not a slice(0,10) prefix — otherwise `2023-05-01; DROP TABLE`
  // would validate as `2023-05-01`, smuggling a tail through for any caller that mishandles it (#80).
  const day = (raw ?? '').trim();
  if (!DAY_RE.test(day)) return { ok: false, reason: 'датата трябва да е във формат YYYY-MM-DD' };
  if (!isRealCalendarDay(day)) return { ok: false, reason: 'несъществуваща дата' };
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

export type FetchImpl = (url: string) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;

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
        // Bound BEFORE buffering: if the server DECLARES an oversized body via Content-Length, withhold
        // it without reading — res.text() below would otherwise pull the whole untrusted payload into
        // Worker memory first. This is the real peak-memory bound; the post-read byte check is the
        // fallback for a missing / under-stated header (review #80).
        const declared = Number(res.headers?.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) {
          return { label, error: 'отговорът е твърде голям (отрязан)', truncated: true };
        }
        const body = await res.text();
        // UTF-8 byte count — body.length is UTF-16 code units, which undercount Cyrillic chars by ~2×
        // (each Cyrillic char is 2 UTF-8 bytes, 1 UTF-16 unit), so the cap would fire at ~2× the intended
        // limit when using body.length directly (review #80, Bozhidar).
        const bodyBytes = new TextEncoder().encode(body).length;
        if (bodyBytes > maxBytes) {
          // Fallback when Content-Length was absent/inaccurate: the body is already buffered here, so
          // this bounds what reaches the MODEL/parse, not peak memory. Do NOT parse it — surface a soft
          // error so the oversized untrusted file never reaches the model (review #80).
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
