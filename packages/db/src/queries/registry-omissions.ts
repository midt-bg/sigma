import { filingsNameCompany, type DeclaredCompany, type DeclaredFilings } from '@sigma/shared';

/** One filing of a person: its declared year, the ЕИК the resolver tied to it, and every entry's text. */
export interface FilingEvidence {
  year: string | null;
  eiks: readonly string[];
  named: readonly string[];
}

/** A person's filings of every type, pooled by declared year: an entry, a change or a second annual
 *  declaration of the year speaks for that year as much as the annual one. */
export function filingsByYear(filings: readonly FilingEvidence[]): Map<string, DeclaredFilings> {
  const byYear = new Map<string, { eiks: string[]; named: string[] }>();
  for (const f of filings) {
    if (!f.year) continue;
    const year = byYear.get(f.year) ?? { eiks: [], named: [] };
    year.eiks.push(...f.eiks);
    // Every parsed entry counts, an empty one included: `named.length` is how much of the year was read.
    year.named.push(...f.named.map((n) => n ?? ''));
    byYear.set(f.year, year);
  }
  return byYear;
}

/**
 * The register-versus-declaration comparison for a company the register records the person in at the
 * end of `year`. Null — no note — when any filing of the year names the company, and when not one entry
 * of that year was read: a filing the reader parsed to nothing may be blank or may be unread, and the
 * site cannot tell which. Otherwise the latest earlier year whose filings name the company, if any.
 */
export function registryOmission(
  byYear: ReadonlyMap<string, DeclaredFilings>,
  year: string,
  company: DeclaredCompany,
): { earlierYear: string | null } | null {
  const filings = byYear.get(year);
  if (!filings?.named.length) return null;
  if (filingsNameCompany(filings, company)) return null;
  let earlierYear: string | null = null;
  for (const [y, f] of byYear)
    if (Number(y) < Number(year) && filingsNameCompany(f, company))
      if (earlierYear === null || Number(y) > Number(earlierYear)) earlierYear = y;
  return { earlierYear };
}

/** The names a register history row records, whatever else it carries; unreadable JSON names nothing. */
export function historyNames(namesJson: string | null | undefined): string[] {
  if (!namesJson) return [];
  try {
    const names = JSON.parse(namesJson) as unknown;
    if (!Array.isArray(names)) return [];
    return names
      .map((n) => (typeof n === 'string' ? n : (n as { name?: unknown } | null)?.name))
      .filter((n): n is string => typeof n === 'string' && !!n.trim());
  } catch {
    return [];
  }
}
