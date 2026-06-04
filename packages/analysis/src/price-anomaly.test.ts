import { describe, expect, it } from 'vitest';
import { aggregatePriceSignal, detectPriceAnomaly, type PriceAnomaly } from './price-anomaly';

describe('detectPriceAnomaly', () => {
  it('returns null when the reference price is zero or negative', () => {
    expect(detectPriceAnomaly({ item: 'хляб', unit: 'kg', price: 2, refPrice: 0 })).toBeNull();
    expect(detectPriceAnomaly({ item: 'хляб', unit: 'kg', price: 2, refPrice: -1 })).toBeNull();
  });

  it('scores a normal positive deviation', () => {
    expect(detectPriceAnomaly({ item: 'хляб', unit: 'kg', price: 12, refPrice: 10 })).toEqual({
      item: 'хляб',
      deviationPct: 20,
      severity: 40,
    });
  });
});

describe('aggregatePriceSignal', () => {
  const anomaly: PriceAnomaly = { item: 'хляб', deviationPct: 20, severity: 40 };

  it('averages severity over known anomalies only', () => {
    expect(aggregatePriceSignal([null, anomaly, null])).toBe(40);
  });

  it('returns zero for empty or fully unknown inputs', () => {
    expect(aggregatePriceSignal([])).toBe(0);
    expect(aggregatePriceSignal([null, null])).toBe(0);
  });
});
