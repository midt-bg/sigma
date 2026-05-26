import { CPV_SECTORS } from '@sigma/config';
import type { SectorRef } from '@sigma/api-contract';

const BY_CODE = new Map(CPV_SECTORS.map((s) => [s.code, s]));

/** Resolve a 2-digit CPV division to a display SectorRef (label + short name), or null if unknown. */
export function sectorRef(division: string | null | undefined): SectorRef | null {
  if (!division) return null;
  const s = BY_CODE.get(division);
  if (!s) return null;
  return { code: s.code, label: s.label, short: s.short ?? s.label };
}

export interface SectorTotalRow {
  division: string;
  contracts: number;
  value_eur: number;
}

/** All present CPV divisions with contract counts + value, value-desc — the sector facet source. */
export async function getSectorTotals(db: D1Database): Promise<
  Array<{ sector: SectorRef; contracts: number; valueEur: number }>
> {
  const { results } = await db
    .prepare(`SELECT division, contracts, value_eur FROM sector_totals ORDER BY value_eur DESC`)
    .all<SectorTotalRow>();
  return results
    .map((r) => {
      const sector = sectorRef(r.division);
      return sector ? { sector, contracts: r.contracts, valueEur: r.value_eur } : null;
    })
    .filter((x): x is { sector: SectorRef; contracts: number; valueEur: number } => x !== null);
}
