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

const SECTOR_OPTION_LIMIT = 12;

/** Sector-select dropdown options: the most-active divisions by spend (from sector_totals), resolved
 *  to SectorRef with the short label. Shared by the /flows, /map, /trends and /competition loaders. */
export async function sectorOptions(db: D1Database): Promise<SectorRef[]> {
  const { results } = await db
    .prepare(`SELECT division FROM sector_totals ORDER BY value_eur DESC LIMIT ?`)
    .bind(SECTOR_OPTION_LIMIT)
    .all<{ division: string }>();
  return results
    .map((r) => BY_CODE.get(r.division))
    .filter((s): s is (typeof CPV_SECTORS)[number] => Boolean(s))
    .map((s) => ({ code: s.code, label: s.short ?? s.label, short: s.short ?? s.label }));
}
