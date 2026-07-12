import { describe, expect, it } from 'vitest';
import type { MacroRegionSpend, RegionSpend } from '@sigma/api-contract';
import type { RegionTopBeneficiary } from '@sigma/db';
import {
  activeTopBeneficiaries,
  isActiveShape,
  nextSelected,
  resolveActiveKey,
  shareLabel,
  shareOfTotal,
  tierer,
  tierForShape,
} from './choropleth';

const region = (nuts3: string, nuts2: string, valueEur: number): RegionSpend => ({
  nuts3,
  name: nuts3,
  nuts2,
  nuts2Name: nuts2,
  valueEur,
  contracts: 1,
  authorities: 1,
});
const macro = (nuts2: string, valueEur: number): MacroRegionSpend => ({
  nuts2,
  name: nuts2,
  valueEur,
  contracts: 1,
});

describe('shareOfTotal', () => {
  it('divides value by total', () => {
    expect(shareOfTotal(25, 100)).toBe(0.25);
  });
  it('returns 0 (never NaN/Infinity) for a zero, null or undefined total', () => {
    expect(shareOfTotal(10, 0)).toBe(0);
    expect(shareOfTotal(10, undefined)).toBe(0);
  });
  it('per-part shares against one denominator sum to 1', () => {
    const total = 60 + 30 + 10;
    const sum = [60, 30, 10].reduce((s, v) => s + shareOfTotal(v, total), 0);
    expect(sum).toBeCloseTo(1, 10);
  });
});

describe('shareLabel', () => {
  it('names the oblast numerator in oblast mode', () => {
    expect(shareLabel('oblast')).toBe('Дял от всички области');
  });
  it('names the район numerator in район mode', () => {
    expect(shareLabel('region')).toBe('Дял от всички райони');
  });
});

describe('tierer', () => {
  it('returns tier 0 for non-positive and for an all-zero/empty input', () => {
    const t = tierer([0, 0, 0]);
    expect(t(0)).toBe(0);
    expect(t(-5)).toBe(0);
    expect(tierer([])(100)).toBe(0);
  });
  it('ranks ascending into 1..5 and excludes zeros from the breaks', () => {
    const t = tierer([0, 100, 200, 300, 400, 500]);
    expect(t(50)).toBe(1); // below the first break
    expect(t(0)).toBe(0); // zero stays tier 0 even amongst positives
    // The 0.8 break equals the max for small N, so the max lands in tier 4, not 5.
    expect(t(500)).toBe(4);
    expect(t(99999)).toBe(5); // strictly above every break
  });
  it('one dominant outlier does not flatten the rest (quantiles over non-zero values)', () => {
    const t = tierer([1, 2, 3, 4, 1_000_000]);
    expect(t(1)).toBeLessThan(t(4)); // small values still spread across tiers
  });
});

describe('tierForShape (oblast↔район mapping)', () => {
  const sofia = region('BG411', 'BG41', 90);
  const pernik = region('BG414', 'BG41', 10); // same район as sofia
  const macroByNuts2 = new Map<string, MacroRegionSpend>([['BG41', macro('BG41', 100)]]);
  const tierOblast = tierer([90, 10]);
  const tierRegion = tierer([100]);

  it('colours by the oblast’s own value in oblast mode (siblings can differ)', () => {
    expect(tierForShape(sofia, 'oblast', macroByNuts2, tierOblast, tierRegion)).not.toBe(
      tierForShape(pernik, 'oblast', macroByNuts2, tierOblast, tierRegion),
    );
  });
  it('colours by the parent район’s aggregate in район mode (siblings match)', () => {
    expect(tierForShape(sofia, 'region', macroByNuts2, tierOblast, tierRegion)).toBe(
      tierForShape(pernik, 'region', macroByNuts2, tierOblast, tierRegion),
    );
  });
  it('returns tier 0 for an undefined shape or an unmapped район', () => {
    expect(tierForShape(undefined, 'oblast', macroByNuts2, tierOblast, tierRegion)).toBe(0);
    const orphan = region('BG999', 'BG99', 50);
    expect(tierForShape(orphan, 'region', macroByNuts2, tierOblast, tierRegion)).toBe(0);
  });
});

describe('nextSelected', () => {
  it('desktop click pins the region', () => {
    expect(nextSelected('BG411', null)).toBe('BG411');
  });
  it('click-same deselects (also covers the coarse-pointer repeat-tap case — same toggle, no pointer branch needed)', () => {
    expect(nextSelected('BG411', 'BG411')).toBe(null);
  });
  it('click-other moves the selection', () => {
    expect(nextSelected('BG331', 'BG411')).toBe('BG331');
  });
  it('clicking outside any shape leaves the current selection unchanged', () => {
    expect(nextSelected(undefined, 'BG411')).toBe('BG411');
  });
});

describe('resolveActiveKey', () => {
  it('hover never overrides an existing selection', () => {
    expect(resolveActiveKey('BG411', 'BG331')).toBe('BG411');
  });
  it('falls back to hover when nothing is selected', () => {
    expect(resolveActiveKey(null, 'BG331')).toBe('BG331');
  });
  it('a pinned selection survives a subsequent hover of nothing — clearing hovered (mouseleave) leaves the selection intact', () => {
    expect(resolveActiveKey('BG411', null)).toBe('BG411');
  });
  it('is null when neither is set', () => {
    expect(resolveActiveKey(null, null)).toBe(null);
  });
});

describe('isActiveShape', () => {
  const sofia = region('BG411', 'BG41', 90);
  const pernik = region('BG414', 'BG41', 10);
  const varna = region('BG331', 'BG33', 40);

  it('is false with no hovered region or an undefined shape', () => {
    expect(isActiveShape(sofia, null, 'oblast')).toBe(false);
    expect(isActiveShape(undefined, sofia, 'oblast')).toBe(false);
  });
  it('matches only the exact oblast in oblast mode', () => {
    expect(isActiveShape(sofia, sofia, 'oblast')).toBe(true);
    expect(isActiveShape(pernik, sofia, 'oblast')).toBe(false);
  });
  it('matches every oblast in the hovered район in район mode', () => {
    expect(isActiveShape(pernik, sofia, 'region')).toBe(true); // same nuts2
    expect(isActiveShape(varna, sofia, 'region')).toBe(false); // different nuts2
  });
});

describe('activeTopBeneficiaries', () => {
  const sofia = region('BG411', 'BG41', 90);
  const bidders: RegionTopBeneficiary[] = [
    { bidderId: 'b1', name: 'Alpha OOD', valueEur: 60, share: 0.6 },
    { bidderId: 'b2', name: 'Beta EOOD', valueEur: 40, share: 0.4 },
  ];
  const topBeneficiaries: Record<string, RegionTopBeneficiary[]> = { BG411: bidders };

  it('returns the hovered oblast’s list in oblast mode', () => {
    expect(activeTopBeneficiaries('oblast', sofia, topBeneficiaries)).toBe(bidders);
  });
  it('is undefined in район mode, even with a hovered region', () => {
    expect(activeTopBeneficiaries('region', sofia, topBeneficiaries)).toBeUndefined();
  });
  it('is undefined with no hovered region', () => {
    expect(activeTopBeneficiaries('oblast', null, topBeneficiaries)).toBeUndefined();
  });
  it('is undefined when the loader has no entry for that oblast, and never crashes', () => {
    const varna = region('BG331', 'BG33', 40);
    expect(activeTopBeneficiaries('oblast', varna, topBeneficiaries)).toBeUndefined();
    expect(activeTopBeneficiaries('oblast', sofia, undefined)).toBeUndefined();
  });
});
