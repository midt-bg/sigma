import type { ContractDetail } from '@sigma/api-contract';

export type RiskFlagType = 'eu_no_competition' | 'no_competition' | 'high_markup' | 'anomalies';

export interface RiskIndicatorResult {
  type: RiskFlagType;
  deltaPct?: number;
}

export function evaluateRiskIndicators(contract: ContractDetail): RiskIndicatorResult[] {
  const flags: RiskIndicatorResult[] = [];

  const admitted =
    contract.bidsReceived != null ? contract.bidsReceived - (contract.bidsRejected || 0) : null;

  if (admitted === 1) {
    if (contract.euFunded) {
      flags.push({ type: 'eu_no_competition' });
    } else {
      flags.push({ type: 'no_competition' });
    }
  }

  if (contract.value?.deltaPct != null && contract.value.deltaPct > 0.2) {
    flags.push({ type: 'high_markup', deltaPct: contract.value.deltaPct });
  }

  if (contract.dateSuspect || contract.value?.suspect) {
    flags.push({ type: 'anomalies' });
  }

  return flags;
}
