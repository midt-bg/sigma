import { describe, expect, it } from 'vitest';
import type { MacroRegionSpend, RegionSpend } from '@sigma/api-contract';
import type { RegionTopBeneficiary } from '@sigma/db';
import {
  activeTopBeneficiaries,
  isActiveShape,
  nextSelected,
  onGroupSwitch,
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

describe('tierForShape (oblast vs район, each coloured by its own value)', () => {
  const sofia = region('BG411', 'BG41', 90);
  const pernik = region('BG414', 'BG41', 10); // same район as sofia, different oblast value
  const bg41 = macro('BG41', 100);
  const tierOblast = tierer([90, 10]);
  const tierRegion = tierer([100]);

  it('colours by the oblast’s own value in oblast mode (siblings can differ)', () => {
    expect(tierForShape(sofia, 'oblast', tierOblast, tierRegion)).not.toBe(
      tierForShape(pernik, 'oblast', tierOblast, tierRegion),
    );
  });
  it('colours a район shape directly by its own aggregate in район mode', () => {
    expect(tierForShape(bg41, 'region', tierOblast, tierRegion)).toBe(
      tierForShape(macro('BG41', 100), 'region', tierOblast, tierRegion),
    );
  });
  it('returns tier 0 for an undefined shape', () => {
    expect(tierForShape(undefined, 'oblast', tierOblast, tierRegion)).toBe(0);
    expect(tierForShape(undefined, 'region', tierOblast, tierRegion)).toBe(0);
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

describe('isActiveShape (direct id equality)', () => {
  it('is false with no active key', () => {
    expect(isActiveShape('BG411', null)).toBe(false);
  });
  it('matches only the exact oblast id in oblast mode', () => {
    expect(isActiveShape('BG411', 'BG411')).toBe(true);
    expect(isActiveShape('BG414', 'BG411')).toBe(false);
  });
  it('matches only the exact район id in район mode — no more oblast cross-referencing', () => {
    expect(isActiveShape('BG41', 'BG41')).toBe(true);
    expect(isActiveShape('BG33', 'BG41')).toBe(false);
  });
});

describe('onGroupSwitch', () => {
  const sofia = region('BG411', 'BG41', 90);
  const varna = region('BG331', 'BG33', 40);
  const byNuts3 = new Map([
    ['BG411', sofia],
    ['BG331', varna],
  ]);

  it('carries a pinned oblast forward to its own район when switching to район mode', () => {
    expect(onGroupSwitch('region', 'BG411', byNuts3)).toEqual({
      selectedOblast: 'BG411',
      selectedRegion: 'BG41',
    });
  });
  it('resolves no selection to no район when switching to район mode', () => {
    expect(onGroupSwitch('region', null, byNuts3)).toEqual({
      selectedOblast: null,
      selectedRegion: null,
    });
  });
  it('clears the selection outright when switching back to oblast mode', () => {
    expect(onGroupSwitch('oblast', 'BG411', byNuts3)).toEqual({
      selectedOblast: null,
      selectedRegion: null,
    });
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
