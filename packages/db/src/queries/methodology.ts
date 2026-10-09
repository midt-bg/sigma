import type { HomeTotals } from '@sigma/api-contract';
import { toHomeTotals, type HomeTotalsRow } from './home';
import { FRAMEWORK_AGREEMENT } from './framework';

interface MethodologyTotalsRow extends HomeTotalsRow {
  first_date: string | null;
  last_date: string | null;
}

interface ContractCoverageRow extends Partial<Record<ValueVerdict, number | null>> {
  total: number;
  bids: number;
  eu: number;
  dur: number;
  lot: number;
}

/**
 * How each contract's value stands in the sums — methodology §2 lists every one with its count: the
 * value_flag verdicts of the summed rows, the rows with no usable value, and framework agreements, whose
 * own record is a ceiling and never summed whatever its verdict. Together they cover every contract.
 */
export type ValueVerdict =
  | 'ok'
  | 'value_low'
  | 'value_suspect'
  | 'annex_suspect'
  | 'annex_total_suspect'
  | 'review'
  | 'missing'
  | 'framework';

const OWN = `framework IS NOT ${FRAMEWORK_AGREEMENT}`;
const SUMMED = `${OWN} AND amount_eur IS NOT NULL AND value_flag`;
const VALUE_VERDICTS: Record<ValueVerdict, string> = {
  ok: `${SUMMED} = 'ok'`,
  value_low: `${SUMMED} = 'value_low'`,
  value_suspect: `${SUMMED} = 'value_suspect'`,
  annex_suspect: `${SUMMED} = 'annex_suspect'`,
  annex_total_suspect: `${SUMMED} = 'annex_total_suspect'`,
  review: `${SUMMED} = 'review'`,
  missing: `${OWN} AND amount_eur IS NULL`,
  framework: `framework = ${FRAMEWORK_AGREEMENT}`,
};

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
  /** Contracts per value verdict, counted in the same pass as the coverage. */
  valueVerdicts: Record<ValueVerdict, number>;
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
        `SELECT COUNT(*) AS total, COUNT(bids_received) AS bids, COUNT(eu_programme) AS eu, COUNT(duration_days) AS dur, COUNT(lot_id) AS lot,
                ${Object.entries(VALUE_VERDICTS)
                  .map(([key, when]) => `SUM(${when}) AS ${key}`)
                  .join(', ')}
         FROM contracts`,
      )
      .first<ContractCoverageRow>(),
    db.prepare(`SELECT COUNT(*) AS n FROM sector_totals`).first<{ n: number }>(),
  ]);

  const totals = toHomeTotals(totalsRow);

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
    valueVerdicts: Object.fromEntries(
      Object.keys(VALUE_VERDICTS).map((key) => [key, coverageRow?.[key as ValueVerdict] ?? 0]),
    ) as Record<ValueVerdict, number>,
  };
}
