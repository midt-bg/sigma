// Regional spending: total procurement value per Bulgarian region (NUTS3), for the /map choropleth.
// The default (no filter) reads the authority_totals rollup grouped by region (cheap, no 190k scan);
// a sector/year/funding filter falls back to a scoped base aggregation, exactly like getFlows. Region
// comes from authorities.region (OCDS NUTS, ~half of authorities), so we always split out an
// "unattributed" bucket and report coverage; the 28 regions are zero-filled so the map colours all of them.

import type { MacroRegionSpend, RegionSpend, RegionalSpending } from '@sigma/api-contract';
import { BG_REGIONS, regionByName } from '@sigma/config';
import { sectorOptions } from './sectors';

export interface RegionalParams {
  sector?: string | null;
  year?: string | null;
  funding?: 'all' | 'eu' | 'national';
}

interface RegionRow {
  region: string | null;
  value_eur: number;
  contracts: number;
  authorities: number;
}

async function regionRows(db: D1Database, p: RegionalParams): Promise<RegionRow[]> {
  const filtered = Boolean(p.sector || p.year || (p.funding && p.funding !== 'all'));
  if (!filtered) {
    const { results } = await db
      .prepare(
        `SELECT region, COALESCE(SUM(spent_eur), 0) AS value_eur, COALESCE(SUM(contracts), 0) AS contracts,
                COUNT(*) AS authorities
         FROM authority_totals GROUP BY region`,
      )
      .all<RegionRow>();
    return results;
  }
  // Site-wide value basis (amount_eur IS NOT NULL), matching authority_totals (the unfiltered path)
  // and the rest of the site, so a region's spend does not change basis when a filter is applied.
  const where = ['c.amount_eur IS NOT NULL'];
  const params: unknown[] = [];
  if (p.sector) {
    where.push('substr(t.cpv_code, 1, 2) = ?');
    params.push(p.sector);
  }
  if (p.year) {
    where.push('substr(c.signed_at, 1, 4) = ?');
    params.push(p.year);
  }
  if (p.funding === 'eu') where.push('c.eu_funded = 1');
  else if (p.funding === 'national') where.push('(c.eu_funded IS NULL OR c.eu_funded = 0)');
  const { results } = await db
    .prepare(
      `SELECT a.region AS region, COALESCE(SUM(c.amount_eur), 0) AS value_eur, COUNT(*) AS contracts,
              COUNT(DISTINCT a.id) AS authorities
       FROM contracts c JOIN tenders t ON t.id = c.tender_id JOIN authorities a ON a.id = t.authority_id
       WHERE ${where.join(' AND ')} GROUP BY a.region`,
    )
    .bind(...params)
    .all<RegionRow>();
  return results;
}

export async function getRegionalSpending(
  db: D1Database,
  p: RegionalParams,
): Promise<RegionalSpending> {
  const [rows, sectors] = await Promise.all([regionRows(db, p), sectorOptions(db)]);

  const byNuts3 = new Map<string, RegionRow>();
  const unattributed = { valueEur: 0, contracts: 0, authorities: 0 };
  for (const r of rows) {
    const region = regionByName(r.region);
    if (!region) {
      unattributed.valueEur += r.value_eur;
      unattributed.contracts += r.contracts;
      unattributed.authorities += r.authorities;
      continue;
    }
    byNuts3.set(region.nuts3, r);
  }

  // Zero-fill all 28 regions so the choropleth colours every region (and the list is complete).
  const regions: RegionSpend[] = BG_REGIONS.map((reg) => {
    const r = byNuts3.get(reg.nuts3);
    return {
      nuts3: reg.nuts3,
      name: reg.name,
      nuts2: reg.nuts2,
      nuts2Name: reg.nuts2Name,
      valueEur: r?.value_eur ?? 0,
      contracts: r?.contracts ?? 0,
      authorities: r?.authorities ?? 0,
    };
  }).sort((a, b) => b.valueEur - a.valueEur);

  const macroByCode = new Map<string, MacroRegionSpend>();
  for (const r of regions) {
    const m = macroByCode.get(r.nuts2) ?? {
      nuts2: r.nuts2,
      name: r.nuts2Name,
      valueEur: 0,
      contracts: 0,
    };
    m.valueEur += r.valueEur;
    m.contracts += r.contracts;
    macroByCode.set(r.nuts2, m);
  }
  const macroRegions = [...macroByCode.values()].sort((a, b) => b.valueEur - a.valueEur);

  const withRegion = regions.reduce((s, r) => s + r.authorities, 0);
  const total = withRegion + unattributed.authorities;

  return {
    regions,
    macroRegions,
    sectors,
    unattributed,
    coverage: { withRegion, total, pct: total > 0 ? withRegion / total : 0 },
    totalValueEur: regions.reduce((s, r) => s + r.valueEur, 0),
    scope: {
      sector: p.sector ?? null,
      year: p.year ? Number(p.year) : null,
      funding: p.funding ?? 'all',
    },
  };
}
