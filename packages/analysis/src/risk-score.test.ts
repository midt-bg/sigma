import { describe, expect, it } from 'vitest';
import { computeRiskScore } from './risk-score';
import { aggregatePriceSignal, detectPriceAnomaly } from './price-anomaly';
import { detectCoBidding } from './cartel';

describe('computeRiskScore', () => {
  it('returns 0 for a clean tender', () => {
    const r = computeRiskScore({ spec: 0, price: 0, competition: 0, cartel: 0, process: 0 });
    expect(r.score).toBe(0);
    expect(r.band).toBe('low');
  });

  it('returns 100 for a maximally risky tender', () => {
    const r = computeRiskScore({
      spec: 100,
      price: 100,
      competition: 100,
      cartel: 100,
      process: 100,
    });
    expect(r.score).toBe(100);
    expect(r.band).toBe('critical');
  });

  it('clamps out-of-range signals', () => {
    const r = computeRiskScore({ spec: 999, price: -50, competition: 0, cartel: 0, process: 0 });
    expect(r.score).toBe(25); // 100 * 0.25
    expect(r.band).toBe('medium');
  });

  it('keeps the score finite when a signal is NaN', () => {
    const r = computeRiskScore({ spec: NaN, price: 0, competition: 0, cartel: 0, process: 0 });
    expect(Number.isFinite(r.score)).toBe(true);
    expect(r.score).toBe(0);
    expect(r.band).toBe('low');
  });
});

describe('detectPriceAnomaly', () => {
  it('flags overpricing', () => {
    const a = detectPriceAnomaly({ item: 'хляб', unit: 'kg', price: 3, refPrice: 2 });
    expect(a).toMatchObject({ deviationPct: 50, severity: 100 });
  });

  it('returns parity at the reference price', () => {
    const a = detectPriceAnomaly({ item: 'хляб', unit: 'kg', price: 2, refPrice: 2 });
    expect(a).toMatchObject({ deviationPct: 0, severity: 0 });
  });

  it('aggregates an empty set to zero', () => {
    expect(aggregatePriceSignal([])).toBe(0);
  });
});

describe('detectCoBidding', () => {
  it('returns 0 with fewer than two co-bidders', () => {
    expect(detectCoBidding('t1', [{ bidderId: 'b1', tenderIds: ['t1'] }])).toBe(0);
  });

  it('scores fully overlapping bidders at the maximum', () => {
    const score = detectCoBidding('t1', [
      { bidderId: 'b1', tenderIds: ['t1', 't2', 't3'] },
      { bidderId: 'b2', tenderIds: ['t1', 't2', 't3'] },
    ]);
    expect(score).toBe(100);
  });
});
