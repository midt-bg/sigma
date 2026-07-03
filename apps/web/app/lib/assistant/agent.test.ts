import { describe, expect, it } from 'vitest';
import { resolveMaxSteps } from './agent';

describe('resolveMaxSteps', () => {
  it('uses the default for a missing or non-numeric value', () => {
    expect(resolveMaxSteps(undefined)).toBe(6);
    expect(resolveMaxSteps('')).toBe(6);
    expect(resolveMaxSteps('abc')).toBe(6);
  });

  it('falls back to the default for 0 or a negative value (never stalls the loop)', () => {
    expect(resolveMaxSteps('0')).toBe(6);
    expect(resolveMaxSteps('-4')).toBe(6);
  });

  it('clamps an over-large value to the hard ceiling (never uncaps BgGPT calls)', () => {
    expect(resolveMaxSteps('9999')).toBe(20);
  });

  it('passes a sane in-range value through (flooring fractions)', () => {
    expect(resolveMaxSteps('3')).toBe(3);
    expect(resolveMaxSteps('20')).toBe(20);
    expect(resolveMaxSteps('4.9')).toBe(4);
  });
});
