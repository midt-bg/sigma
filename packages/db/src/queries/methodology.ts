import type { HomeTotals } from '@sigma/api-contract';

interface MethodologyTotalsRow {
  contracts: number;
  value_eur: number;
  authorities: number;
  bidders: number;
  suspect: number;
  first_date: string | null;
  last_date: string | null;
  as_of: string | null;
  refreshed_at: string;
}

interface ContractCoverageRow {
  total: number;
  bids: number;
  eu: number;
  dur: number;
  lot: number;
}

export interface MethodologyStats {
  totals: HomeTotals;
  firstDate: string | null;
  lastDate: string | null;
  coverage: {
    bids: number;
    eu: number;
    duration: number;
    lot: number;
  };
  sectors: number;
}

/** Methodology page: live corpus totals plus field coverage used in the known-gaps table. */
export async function getMethodologyStats(db: D1Database): Promise<MethodologyStats> {
  const [totalsRow, coverageRow, sectorsRow] = await Promise.all([
    db
      .prepare(
        `SELECT contracts, value_eur, authorities, bidders, suspect, first_date, last_date, as_of, refreshed_at FROM home_totals WHERE id = 1`,
      )
      .first<MethodologyTotalsRow>(),
    db
      .prepare(
        `SELECT COUNT(*) AS total, COUNT(bids_received) AS bids, COUNT(eu_programme) AS eu, COUNT(duration_days) AS dur, COUNT(lot_id) AS lot FROM contracts`,
      )
      .first<ContractCoverageRow>(),
    db.prepare(`SELECT COUNT(*) AS n FROM sector_totals`).first<{ n: number }>(),
  ]);

  const totals: HomeTotals = totalsRow
    ? {
        contracts: totalsRow.contracts,
        valueEur: totalsRow.value_eur,
        authorities: totalsRow.authorities,
        bidders: totalsRow.bidders,
        suspect: totalsRow.suspect,
        asOf: totalsRow.as_of,
        refreshedAt: totalsRow.refreshed_at,
      }
    : {
        contracts: 0,
        valueEur: 0,
        authorities: 0,
        bidders: 0,
        suspect: 0,
        asOf: null,
        refreshedAt: '',
      };

  const total = coverageRow?.total ?? 0;
  const ratio = (n: number | undefined) => (total > 0 ? (n ?? 0) / total : 0);

  return {
    totals,
    firstDate: totalsRow?.first_date ?? null,
    lastDate: totalsRow?.last_date ?? null,
    coverage: {
      bids: ratio(coverageRow?.bids),
      eu: ratio(coverageRow?.eu),
      duration: ratio(coverageRow?.dur),
      lot: ratio(coverageRow?.lot),
    },
    sectors: sectorsRow?.n ?? 0,
  };
}
