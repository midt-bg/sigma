// Regional spending: total procurement value per Bulgarian region (NUTS3), for the /map choropleth.
// The default (no filter) reads the authority_totals rollup grouped by region (cheap, no 190k scan);
// a sector/year/funding filter falls back to a scoped base aggregation, exactly like getFlows. Region
// comes from authorities.region (OCDS NUTS, ~half of authorities), so we always split out an
// "unattributed" bucket and report coverage; the 28 regions are zero-filled so the map colours all of them.

import type { MacroRegionSpend, RegionSpend, RegionalSpending } from '@sigma/api-contract';
import { BG_REGIONS, regionByName } from '@sigma/config';
import { cleanName } from '@sigma/shared';
import { sectorOptions } from './sectors';

export interface RegionalParams {
  sector?: string | null;
  year?: string | null;
  funding?: 'all' | 'eu' | 'national';
}

export interface RegionTopBeneficiary {
  bidderId: string;
  name: string;
  valueEur: number;
  share: number;
}

interface RegionRow {
  region: string | null;
  value_eur: number;
  contracts: number;
  authorities: number;
}

// Shared sector/year/funding WHERE-clause builder, so regionRows() and getRegionTopBeneficiaries()
// can never drift apart on scope semantics. Site-wide value basis (amount_eur IS NOT NULL) matches
// authority_totals (the unfiltered path) and the rest of the site.
function scopeFilters(p: RegionalParams): { where: string[]; params: unknown[] } {
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
  return { where, params };
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
  const { where, params } = scopeFilters(p);
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

interface TopBeneficiaryRow {
  region: string | null;
  bidder_id: string;
  name: string;
  value_eur: number;
  region_total: number;
}

// Top 3 bidder companies per NUTS3 region by awarded value, plus each one's share of the
// region's TRUE total value (every contract in the region, including ones whose bidder_id has
// no matching `bidders` row). `bidders` is LEFT JOINed (not INNER) so those contracts stay in the
// same grouped result instead of being dropped before the window runs: `region_total` sums over
// the WHOLE partition (one pass, no second scan of contracts/tenders/authorities — D1 bills per
// row scanned), while the outer filter excludes only the no-name group from being ranked/shown as
// a "beneficiary" (ordering unmatched-bidder groups last means a large unattributed value can't
// crowd a real company out of the top 3). Share is therefore read against this query's own
// SUM(c.amount_eur) region total, computed the same way regionRows() computes it in the FILTERED
// path. Caveat: getRegionalSpending's UNFILTERED path instead reads the materialized
// authority_totals.spent_eur rollup — the two are refreshed together by the ETL and expected to
// agree, but nothing at query time enforces that equality, so a staleness/drift in that rollup
// would show this share against a slightly different "Стойност" than the unfiltered card figure.
export async function getRegionTopBeneficiaries(
  db: D1Database,
  p: RegionalParams,
): Promise<Map<string, RegionTopBeneficiary[]>> {
  const { where, params } = scopeFilters(p);
  where.push('a.region IS NOT NULL');
  const { results } = await db
    .prepare(
      `SELECT region, bidder_id, name, value_eur, region_total FROM (
         SELECT a.region AS region, c.bidder_id AS bidder_id, b.name AS name,
                SUM(c.amount_eur) AS value_eur,
                SUM(SUM(c.amount_eur)) OVER (PARTITION BY a.region) AS region_total,
                ROW_NUMBER() OVER (
                  PARTITION BY a.region
                  ORDER BY (CASE WHEN b.name IS NULL THEN 1 ELSE 0 END), SUM(c.amount_eur) DESC
                ) AS rn
         FROM contracts c JOIN tenders t ON t.id = c.tender_id
              JOIN authorities a ON a.id = t.authority_id LEFT JOIN bidders b ON b.id = c.bidder_id
         WHERE ${where.join(' AND ')}
         GROUP BY a.region, c.bidder_id
       ) WHERE rn <= 3 AND name IS NOT NULL ORDER BY region, rn`,
    )
    .bind(...params)
    .all<TopBeneficiaryRow>();

  const byNuts3 = new Map<string, RegionTopBeneficiary[]>();
  for (const r of results) {
    const region = regionByName(r.region);
    if (!region) continue;
    const list = byNuts3.get(region.nuts3) ?? [];
    list.push({
      bidderId: r.bidder_id,
      name: cleanName(r.name),
      valueEur: r.value_eur,
      share: r.region_total && r.region_total > 0 ? r.value_eur / r.region_total : 0,
    });
    byNuts3.set(region.nuts3, list);
  }
  // Belt-and-suspenders alongside the SQL's `ORDER BY region, rn`: GROUP BY + a window function do
  // not guarantee D1/SQLite's row order, and this list is rendered as a ranked "top 3" — never trust
  // result order for that, sort explicitly by value descending.
  for (const list of byNuts3.values()) list.sort((a, b) => b.valueEur - a.valueEur);
  return byNuts3;
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
