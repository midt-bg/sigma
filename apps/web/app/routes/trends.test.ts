import { describe, expect, it } from 'vitest';
import { logMax, relLabel } from './trends';
import type { CpvGroupStat } from '@sigma/api-contract';

function makeGroup(maxEur: number): CpvGroupStat {
  return {
    group: '33600',
    name: null,
    contracts: 1,
    medianEur: maxEur / 2,
    p10Eur: 0,
    p90Eur: maxEur,
    maxEur,
    sampleEur: [maxEur],
  };
}

describe('logMax', () => {
  it('does not bump an exact power of ten to the next decade', () => {
    // Math.log10(1e7) can land a hair above 7 due to float rounding; the epsilon guard
    // in logMax must keep 1e7 mapped to 1e7, not 1e8.
    expect(logMax([makeGroup(1e7)])).toBe(1e7);
  });

  it('rounds a non-power-of-ten max up to the next decade', () => {
    expect(logMax([makeGroup(2.5e7)])).toBe(1e8);
  });

  it('floors at 1e6 regardless of smaller group maxima', () => {
    expect(logMax([makeGroup(100)])).toBe(1e6);
  });
});

describe('relLabel', () => {
  it('returns an empty label when the cohort median is zero', () => {
    expect(relLabel(1000, 0)).toEqual({ text: '', cls: 'ov-rel-mid' });
  });

  it('returns an empty label when the cohort median is negative', () => {
    expect(relLabel(1000, -5)).toEqual({ text: '', cls: 'ov-rel-mid' });
  });

  it('flags values well above the median', () => {
    expect(relLabel(2000, 1000)).toEqual({ text: '×2 типичното', cls: 'ov-rel-hi' });
  });

  it('flags values well below the median', () => {
    expect(relLabel(500, 1000)).toEqual({ text: 'под типичното', cls: 'ov-rel-lo' });
  });

  it('flags values near the median', () => {
    expect(relLabel(1000, 1000)).toEqual({ text: '≈ типичното', cls: 'ov-rel-mid' });
  });
});
