// relLabel is the "спрямо типичното" (vs. the CPV group median) badge on /trends contract cards.
// medianEur === 0 is a real case (a CPV group whose contracts carry zero/missing value), and
// dividing by it must never surface as a rendered label — see PR #170 review thread on this file.
import { describe, expect, it } from 'vitest';
import { relLabel } from './trends';

describe('relLabel', () => {
  it('returns null instead of dividing by zero when medianEur === 0 and valueEur > 0', () => {
    // Without a guard, valueEur / 0 === Infinity, and Infinity >= 1.3 would pass the 'ov-rel-hi'
    // branch, rendering the label "×Infinity типичното" to the user.
    expect(relLabel(5000, 0)).toBeNull();
  });

  it('returns null instead of producing NaN when both medianEur and valueEur are 0', () => {
    expect(relLabel(0, 0)).toBeNull();
  });

  it('classifies a normal ratio above the median as ov-rel-hi', () => {
    expect(relLabel(1300, 1000)).toEqual({ text: '×1,3 типичното', cls: 'ov-rel-hi' });
  });

  it('classifies a normal ratio below the median as ov-rel-lo', () => {
    expect(relLabel(500, 1000)).toEqual({ text: 'под типичното', cls: 'ov-rel-lo' });
  });

  it('classifies a ratio near the median as ov-rel-mid', () => {
    expect(relLabel(1000, 1000)).toEqual({ text: '≈ типичното', cls: 'ov-rel-mid' });
  });
});
