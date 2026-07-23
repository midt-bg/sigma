import type { ContractDetail } from '@sigma/api-contract';

export type RiskFlagType = 'eu_no_competition' | 'no_competition' | 'high_markup' | 'anomalies';

export interface RiskIndicatorResult {
  type: RiskFlagType;
  deltaPct?: number;
}

/** The fields evaluateRiskIndicators actually reads — a ContractDetail satisfies this structurally.
 *  isSingleOffer/isHighMarkup are the materialized flags (scripts/precompute.sql), so the per-contract
 *  display and the subject-risk rollups share ONE definition, unified on `bids_received = 1`. */
export type RiskFlagInput = Pick<
  ContractDetail,
  'isSingleOffer' | 'isHighMarkup' | 'euFunded' | 'dateSuspect'
> & { value: Pick<ContractDetail['value'], 'deltaPct' | 'suspect'> };

export function evaluateRiskIndicators(contract: RiskFlagInput): RiskIndicatorResult[] {
  const flags: RiskIndicatorResult[] = [];

  if (contract.isSingleOffer) {
    flags.push({ type: contract.euFunded ? 'eu_no_competition' : 'no_competition' });
  }

  // isHighMarkup is the materialized flag; deltaPct is still read for the displayed %. It is NULL on the
  // suspect rows where the flag is also null, so the `!= null` guard stops a stale flag rendering `NaN%`.
  if (contract.isHighMarkup && contract.value.deltaPct != null) {
    flags.push({ type: 'high_markup', deltaPct: contract.value.deltaPct });
  }

  if (contract.dateSuspect || contract.value.suspect) {
    flags.push({ type: 'anomalies' });
  }

  return flags;
}
