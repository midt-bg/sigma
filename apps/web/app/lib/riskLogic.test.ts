import { describe, it, expect } from 'vitest';
import { evaluateRiskIndicators } from './riskLogic';

function buildContract(overrides: any = {}): any {
  return {
    bidsReceived: 2,
    bidsRejected: 0,
    euFunded: false,
    dateSuspect: false,
    value: {
      deltaPct: 0.1,
      suspect: false,
    },
    ...overrides,
  };
}

describe('evaluateRiskIndicators', () => {
  it('returns empty when no risks are present', () => {
    const flags = evaluateRiskIndicators(buildContract());
    expect(flags).toHaveLength(0);
  });

  describe('Competition heuristics', () => {
    it('triggers NO_COMPETITION when exactly 1 bid is admitted (non-EU)', () => {
      const contract = buildContract({ bidsReceived: 3, bidsRejected: 2, euFunded: false });
      const flags = evaluateRiskIndicators(contract);
      expect(flags).toEqual([{ type: 'no_competition' }]);
    });

    it('triggers EU_NO_COMPETITION when exactly 1 bid is admitted and EU funded', () => {
      const contract = buildContract({ bidsReceived: 1, bidsRejected: 0, euFunded: true });
      const flags = evaluateRiskIndicators(contract);
      expect(flags).toEqual([{ type: 'eu_no_competition' }]);
    });

    it('does not trigger competition flags when > 1 bid is admitted', () => {
      const contract = buildContract({ bidsReceived: 2, bidsRejected: 0 });
      const flags = evaluateRiskIndicators(contract);
      expect(flags).not.toContainEqual({ type: 'no_competition' });
      expect(flags).not.toContainEqual({ type: 'eu_no_competition' });
    });
  });

  describe('Markup heuristics', () => {
    it('triggers HIGH_MARKUP when deltaPct > 20%', () => {
      const contract = buildContract({ value: { deltaPct: 0.21, suspect: false } });
      const flags = evaluateRiskIndicators(contract);
      expect(flags).toContainEqual({ type: 'high_markup', deltaPct: 0.21 });
    });

    it('does not trigger HIGH_MARKUP when deltaPct is exactly 20% or less', () => {
      const contract1 = buildContract({ value: { deltaPct: 0.20, suspect: false } });
      const contract2 = buildContract({ value: { deltaPct: 0.19, suspect: false } });
      expect(evaluateRiskIndicators(contract1)).not.toContainEqual(expect.objectContaining({ type: 'high_markup' }));
      expect(evaluateRiskIndicators(contract2)).not.toContainEqual(expect.objectContaining({ type: 'high_markup' }));
    });
  });

  describe('Anomaly heuristics', () => {
    it('triggers ANOMALIES when date is suspect', () => {
      const contract = buildContract({ dateSuspect: true });
      const flags = evaluateRiskIndicators(contract);
      expect(flags).toContainEqual({ type: 'anomalies' });
    });

    it('triggers ANOMALIES when value is suspect', () => {
      const contract = buildContract({ value: { deltaPct: 0, suspect: true } });
      const flags = evaluateRiskIndicators(contract);
      expect(flags).toContainEqual({ type: 'anomalies' });
    });
  });
});
