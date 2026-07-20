// Direct-download URLs for the raw ЦАИС ЕОП open-data files a record was published in.
//
// The public MinIO store at storage.eop.bg exposes one bucket per publication day
// (`open-data-<YYYY-MM-DD>/`) holding fixed, locale-date-named JSON objects. We reconstruct the
// object key from the day alone — the key is NOT stored in our DB, and nothing is proxied or
// cached: the returned href points straight at storage.eop.bg.
//
// Verified live (2020→2026): the three base files below are always present. The OCDS-standard export
// only appears in buckets from 2026-01-01 onward (verified against storage.eop.bg — earlier days
// 404), so it is appended only when the publication day is on/after that cutoff.

const BASE = 'https://storage.eop.bg';

// First day the in-bucket OCDS export exists. ISO dates compare lexically, so a string `>=` is safe.
const OCDS_AVAILABLE_FROM = '2026-01-01';

// Bulgarian noun + display label per base file. The noun is embedded verbatim in the object key.
const BASE_FILES = [
  { noun: 'договори', label: 'Договори' },
  { noun: 'поръчки', label: 'Поръчки' },
  { noun: 'анекси', label: 'Анекси' },
] as const;

export interface EopSourceFile {
  label: string;
  url: string;
}

// YYYY-MM-DD → DD.MM.YYYY, the format embedded in the object key.
function bgDate(day: string): string {
  const [y, m, d] = day.split('-');
  return `${d}.${m}.${y}`;
}

function fileUrl(day: string, key: string): string {
  return `${BASE}/open-data-${day}/${encodeURIComponent(key)}`;
}

/**
 * Build direct links to the day's ЦАИС ЕОП open-data files for a record's publication date — the
 * three base files always, plus the OCDS export when the day is on/after {@link OCDS_AVAILABLE_FROM}.
 * Returns `[]` when the date is missing or not a plain `YYYY-MM-DD` day.
 */
export function eopSourceFiles(publishedAt: string | null | undefined): EopSourceFile[] {
  if (!publishedAt) return [];
  const day = publishedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const bg = bgDate(day);
  const files: EopSourceFile[] = BASE_FILES.map(({ noun, label }) => ({
    label,
    url: fileUrl(
      day,
      `Автоматично генерирани данни за ${noun}, публикувани в ЦАИС ЕОП на ${bg}.json`,
    ),
  }));
  // The OCDS file uses a distinct key shape (trailing „ г., съгласно стандарт OCDS").
  if (day >= OCDS_AVAILABLE_FROM) {
    files.push({
      label: 'Обявления (OCDS)',
      url: fileUrl(
        day,
        `Автоматично генерирани данни за обявления, публикувани в ЦАИС ЕОП на ${bg} г., съгласно стандарт OCDS.json`,
      ),
    });
  }
  return files;
}
