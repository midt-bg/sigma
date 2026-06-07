export const START_YEAR = 2020;
export const FALLBACK_END_YEAR = 2026;

export interface CoverageMeta {
  asOf: string | null;
  refreshedAt: string | null;
  coverageEndYear: number;
}

interface CoverageRow {
  as_of: string | null;
  refreshed_at: string | null;
}

export function coverageEndYear(asOf: string | null | undefined): number {
  const year = asOf?.slice(0, 4);
  return year && /^\d{4}$/.test(year) ? Number(year) : FALLBACK_END_YEAR;
}

export function coverageRange(endYear: number | null | undefined): string {
  return `${START_YEAR}–${endYear ?? FALLBACK_END_YEAR}`;
}

export function coveragePartialNote(endYear: number | null | undefined): string {
  const year = endYear ?? FALLBACK_END_YEAR;
  return `${coverageRange(year)} (${year} г. частично)`;
}

export function yearOptions(endYear: number | null | undefined): string[] {
  const end = endYear ?? FALLBACK_END_YEAR;
  const years: string[] = [];
  for (let year = end; year >= START_YEAR; year -= 1) {
    years.push(String(year));
  }
  return years;
}

export async function getCoverageMeta(db: D1Database): Promise<CoverageMeta> {
  const row = await db
    .prepare('SELECT as_of, refreshed_at FROM home_totals WHERE id = 1')
    .first<CoverageRow>();
  const asOf = row?.as_of ?? null;
  return {
    asOf,
    refreshedAt: row?.refreshed_at ?? null,
    coverageEndYear: coverageEndYear(asOf),
  };
}
