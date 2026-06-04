import { describe, expect, it } from 'vitest';
import { clamp, riskBand, round2 } from './index';

describe('shared utils', () => {
  it('clamps within range', () => {
    expect(clamp(120, 0, 100)).toBe(100);
    expect(clamp(-5, 0, 100)).toBe(0);
    expect(clamp(42, 0, 100)).toBe(42);
    expect(clamp(NaN, 0, 100)).toBe(0);
  });

  it('rounds to two decimals', () => {
    expect(round2(2.346)).toBe(2.35);
    expect(round2(1.234)).toBe(1.23);
  });

  it('maps score to risk band', () => {
    expect(riskBand(0)).toBe('low');
    expect(riskBand(NaN)).toBe('low');
    expect(riskBand(30)).toBe('medium');
    expect(riskBand(60)).toBe('high');
    expect(riskBand(90)).toBe('critical');
  });
});
