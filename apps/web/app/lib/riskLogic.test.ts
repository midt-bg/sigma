import { describe, it, expect } from 'vitest';
import { evaluateRiskIndicators, type RiskFlagInput } from './riskLogic';

// evaluateRiskIndicators reads the materialized flags (isSingleOffer/isHighMarkup) — the same columns the
// subject-risk rollups aggregate (#229) — and deltaPct only for the displayed %. A ContractDetail
// satisfies RiskFlagInput structurally.
function buildContract(overrides: Partial<RiskFlagInput> = {}): RiskFlagInput {
  return {
    isSingleOffer: false,
    isHighMarkup: false,
    euFunded: false,
    dateSuspect: false,
    value: { deltaPct: 0.1, suspect: false },
    ...overrides,
  };
}

describe('evaluateRiskIndicators', () => {
  it('returns empty when no flags are set', () => {
    expect(evaluateRiskIndicators(buildContract())).toEqual([]);
  });

  describe('competition', () => {
    it('flags no_competition when single-offer and not EU funded', () => {
      expect(
        evaluateRiskIndicators(buildContract({ isSingleOffer: true, euFunded: false })),
      ).toEqual([{ type: 'no_competition' }]);
    });

    it('flags eu_no_competition when single-offer and EU funded', () => {
      expect(
        evaluateRiskIndicators(buildContract({ isSingleOffer: true, euFunded: true })),
      ).toEqual([{ type: 'eu_no_competition' }]);
    });

    it('does not flag competition when not single-offer', () => {
      expect(evaluateRiskIndicators(buildContract({ isSingleOffer: false }))).toEqual([]);
    });

    it('does not flag when the single-offer flag is null (unknown bid count)', () => {
      // The flag is the sole input — unified on bids_received = 1; there is no bid-count arithmetic here.
      expect(evaluateRiskIndicators(buildContract({ isSingleOffer: null }))).toEqual([]);
    });
  });

  describe('markup', () => {
    it('flags high_markup when the flag is set, carrying deltaPct for display', () => {
      expect(
        evaluateRiskIndicators(
          buildContract({ isHighMarkup: true, value: { deltaPct: 0.21, suspect: false } }),
        ),
      ).toEqual([{ type: 'high_markup', deltaPct: 0.21 }]);
    });

    it('does not flag high_markup when the flag is false, even with a high deltaPct', () => {
      expect(
        evaluateRiskIndicators(
          buildContract({ isHighMarkup: false, value: { deltaPct: 0.5, suspect: false } }),
        ),
      ).toEqual([]);
    });

    it('does not flag high_markup when the flag is set but deltaPct is null (no NaN%)', () => {
      expect(
        evaluateRiskIndicators(
          buildContract({ isHighMarkup: true, value: { deltaPct: null, suspect: false } }),
        ),
      ).toEqual([]);
    });
  });

  describe('anomalies', () => {
    it('flags anomalies when the date is suspect', () => {
      expect(evaluateRiskIndicators(buildContract({ dateSuspect: true }))).toEqual([
        { type: 'anomalies' },
      ]);
    });

    it('flags anomalies when the value is suspect', () => {
      expect(
        evaluateRiskIndicators(buildContract({ value: { deltaPct: 0, suspect: true } })),
      ).toEqual([{ type: 'anomalies' }]);
    });
  });
});
