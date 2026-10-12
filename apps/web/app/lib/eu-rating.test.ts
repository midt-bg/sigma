import { describe, expect, it } from 'vitest';
import { COMPETITION_MIN_CONTRACTS, EU_SCOREBOARD } from '@sigma/config';
import { euRating, SMALL_SAMPLE_LABEL } from './eu-rating';

describe('euRating', () => {
  it('gives no verdict on a share that too few contracts decide', () => {
    // One contract, one offer: 100 % — and still no „над прага на ЕС" about a named body.
    expect(euRating(1, 1, EU_SCOREBOARD.singleBidder)).toBeNull();
    expect(euRating(1, COMPETITION_MIN_CONTRACTS - 1, EU_SCOREBOARD.directAward)).toBeNull();
  });

  it('rates against the EU thresholds from the minimum sample on', () => {
    expect(euRating(0.5, COMPETITION_MIN_CONTRACTS, EU_SCOREBOARD.singleBidder)).toBe('bad');
    expect(euRating(0.15, 40, EU_SCOREBOARD.singleBidder)).toBe('mid');
    expect(euRating(0.05, 40, EU_SCOREBOARD.singleBidder)).toBe('good');
  });

  it('says why there is no verdict, with the threshold', () => {
    expect(SMALL_SAMPLE_LABEL).toContain(String(COMPETITION_MIN_CONTRACTS));
    expect(SMALL_SAMPLE_LABEL).not.toContain('над прага');
  });
});
