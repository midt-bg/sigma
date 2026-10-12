// The first year of the series is incomplete when the source was still being taken up that year — the
// open data starts in 2020 while the platform was introduced over the year, so 2020 holds a fraction of
// the contracts of 2021. The data says so itself: a first year with fewer than half the contracts of the
// year after it is partial. National counts (facet_counts, rebuilt by every refresh), so the company,
// authority and national tables all mark the same year.

/** First year of the trend window (trend.ts); stray rows dated before it are outside every series. */
export const SERIES_START_YEAR = '2020';

export interface YearCount {
  key: string;
  contracts: number;
}

/** The first year of the series when it is partial by the rule above, else null. */
export function partialStartYearOf(
  rows: readonly YearCount[],
  fromYear: string = SERIES_START_YEAR,
): string | null {
  const years = rows
    .filter((r) => /^\d{4}$/.test(r.key) && r.key >= fromYear && r.contracts > 0)
    .sort((a, b) => a.key.localeCompare(b.key));
  const first = years[0];
  if (!first) return null;
  const next = years.find((r) => r.key === String(Number(first.key) + 1));
  if (!next) return null;
  return first.contracts * 2 < next.contracts ? first.key : null;
}

/** Reads the national year counts once (a dozen rows); a database the refresh has not filled has none. */
export async function getPartialStartYear(db: D1Database): Promise<string | null> {
  try {
    const rows = await db
      .prepare(`SELECT key, contracts FROM facet_counts WHERE facet = 'year'`)
      .all<YearCount>();
    return partialStartYearOf(rows.results ?? []);
  } catch (error) {
    if (/no such table:?\s*facet_counts/i.test(String(error))) return null;
    throw error;
  }
}
