import { describe, expect, it } from 'vitest';
import { band, score100 } from './quality';

describe('score100 / band boundary agreement', () => {
  it('0.695 rounds to "70" and bands as good, matching the 70-100 = good methodology', () => {
    expect(score100(0.695)).toBe('70');
    expect(band(0.695)).toBe('good');
  });

  it('0.7 displays as "70" and bands as good', () => {
    expect(score100(0.7)).toBe('70');
    expect(band(0.7)).toBe('good');
  });

  it('0.495 rounds to "50" and bands as mid, not weak', () => {
    expect(score100(0.495)).toBe('50');
    expect(band(0.495)).toBe('mid');
  });
});
