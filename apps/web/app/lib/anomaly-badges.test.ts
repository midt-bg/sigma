import { describe, expect, it } from 'vitest';
import type { AnomalySignals } from '@sigma/api-contract';
import { anomalyBadges, formatTimes } from './anomaly-badges';

const NBSP = '\u00A0'; // non-breaking space, as emitted by @sigma/shared formatters

const none: AnomalySignals = {
  overEstimateRatio: null,
  estimatedEur: null,
  annexGrowthRatio: null,
  priceRatio: null,
  peerMedianEur: null,
  peerCount: null,
  singleBid: false,
  noNotice: false,
};

describe('formatTimes', () => {
  it('renders one decimal with a Bulgarian comma, dropping a trailing ,0', () => {
    expect(formatTimes(2.53)).toBe('×2,5');
    expect(formatTimes(12)).toBe('×12');
    expect(formatTimes(1.1)).toBe('×1,1');
  });

  it('renders extreme ratios as whole numbers with the thousands separator', () => {
    expect(formatTimes(104527.7)).toBe(`×104${NBSP}528`);
  });
});

describe('anomalyBadges', () => {
  it('maps every fired signal in severity order, price signals plain and context soft', () => {
    const badges = anomalyBadges({
      overEstimateRatio: 2.5,
      estimatedEur: 102258,
      annexGrowthRatio: 1.6,
      priceRatio: 12,
      peerMedianEur: 41666,
      peerCount: 120,
      singleBid: true,
      noNotice: true,
    });

    expect(badges.map((b) => b.key)).toEqual([
      'over_estimate',
      'annex_growth',
      'price_outlier',
      'single_bid',
      'no_notice',
    ]);
    expect(badges.map((b) => b.context)).toEqual([false, false, false, true, true]);

    expect(badges[0]).toMatchObject({
      label: '×2,5 над прогнозата',
      detail: `(при 102${NBSP}хил.${NBSP}€)`,
    });
    expect(badges[1]).toMatchObject({ label: '+60% чрез анекси', detail: null });
    expect(badges[2]!.label).toBe('×12 над типичното');
    expect(badges[2]!.detail).toBe(`(медиана 42${NBSP}хил.${NBSP}€ от 120 договора)`);
    expect(badges[3]).toMatchObject({ label: 'единствена оферта', detail: null });
    expect(badges[4]).toMatchObject({ label: 'без обявление', detail: null });
  });

  it('renders nothing for a signal-less row and omits absent evidence details', () => {
    expect(anomalyBadges(none)).toEqual([]);
    const noEvidence = anomalyBadges({ ...none, priceRatio: 7.2, peerMedianEur: null });
    expect(noEvidence).toHaveLength(1);
    expect(noEvidence[0]).toMatchObject({ label: '×7,2 над типичното', detail: null });
  });

  it('rounds the annex growth to whole percents', () => {
    const badges = anomalyBadges({ ...none, annexGrowthRatio: 1.2345 });
    expect(badges[0]!.label).toBe('+23% чрез анекси');
  });
});
