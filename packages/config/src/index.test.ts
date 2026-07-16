import { describe, expect, it } from 'vitest';
import {
  CLASSIFIED_PROCEDURE_TYPES,
  CPV_CATEGORIES,
  CPV_SECTORS,
  EU_SCOREBOARD,
  NON_COMPETITIVE_PROCEDURE_TYPES,
  categoryForDivision,
  procedureGroup,
  rateLowerIsBetter,
} from './index';

describe('CPV_CATEGORIES', () => {
  it('partitions exactly the configured CPV sector divisions', () => {
    const sectorCodes = CPV_SECTORS.map((sector) => sector.code).sort();
    const categoryCodes = CPV_CATEGORIES.flatMap((category) => category.divisions);

    expect(categoryCodes).toHaveLength(45);
    expect(new Set(categoryCodes).size).toBe(45);
    expect([...categoryCodes].sort()).toEqual(sectorCodes);
  });

  it('does not assign a division to more than one category', () => {
    const counts = new Map<string, number>();

    for (const division of CPV_CATEGORIES.flatMap((category) => category.divisions)) {
      counts.set(division, (counts.get(division) ?? 0) + 1);
    }

    const duplicates = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([division]) => division);

    expect(duplicates).toEqual([]);
  });

  it('maps a CPV division/full code to its curated category', () => {
    expect(categoryForDivision('45233120-6')?.key).toBe('construction');
    expect(categoryForDivision('15800000')?.key).toBe('food-agri');
    expect(categoryForDivision(null)).toBeNull();
    expect(categoryForDivision('99000000')).toBeNull();
  });
});

describe('procedureGroup', () => {
  it('maps a known procedure type to its display group', () => {
    expect(procedureGroup('Пряко договаряне')).toMatchObject({
      key: 'direct',
      competitive: false,
      label: 'Пряко / без обявление',
    });
  });

  it('falls back to the unknown bucket for unrecognised procedure types', () => {
    expect(procedureGroup('несъществуваща процедура')).toMatchObject({
      key: 'unknown',
      competitive: null,
      label: 'Неизвестна',
    });
  });
});

describe('procedure-type classification lists', () => {
  it('lists only non-competitive (direct-award) procedure types', () => {
    expect(NON_COMPETITIVE_PROCEDURE_TYPES).toContain('Пряко договаряне');
    expect(NON_COMPETITIVE_PROCEDURE_TYPES).toContain('Договаряне без предварително обявление');
    expect(NON_COMPETITIVE_PROCEDURE_TYPES).not.toContain('Открита процедура');
    // every listed type folds back to the non-competitive group
    for (const t of NON_COMPETITIVE_PROCEDURE_TYPES) {
      expect(procedureGroup(t).competitive).toBe(false);
    }
  });

  it('classified denominator excludes neutral and synthetic procedures', () => {
    expect(CLASSIFIED_PROCEDURE_TYPES).toContain('Открита процедура'); // competitive
    expect(CLASSIFIED_PROCEDURE_TYPES).toContain('Пряко договаряне'); // non-competitive
    expect(CLASSIFIED_PROCEDURE_TYPES).not.toContain('неизвестна'); // synthetic
    expect(CLASSIFIED_PROCEDURE_TYPES).not.toContain('Покана до определени лица'); // neutral
    // never asserts null competitiveness
    for (const t of CLASSIFIED_PROCEDURE_TYPES) {
      expect(procedureGroup(t).competitive).not.toBeNull();
    }
  });
});

describe('rateLowerIsBetter (EU Single Market Scoreboard)', () => {
  it('rates the single-bidder share against the EU band', () => {
    expect(rateLowerIsBetter(0.08, EU_SCOREBOARD.singleBidder)).toBe('good'); // ≤ 10%
    expect(rateLowerIsBetter(0.15, EU_SCOREBOARD.singleBidder)).toBe('mid'); // between
    expect(rateLowerIsBetter(0.25, EU_SCOREBOARD.singleBidder)).toBe('bad'); // ≥ 20%
  });

  it('rates the direct-award share against the EU band', () => {
    expect(rateLowerIsBetter(0.04, EU_SCOREBOARD.directAward)).toBe('good'); // ≤ 5%
    expect(rateLowerIsBetter(0.07, EU_SCOREBOARD.directAward)).toBe('mid'); // between
    expect(rateLowerIsBetter(0.12, EU_SCOREBOARD.directAward)).toBe('bad'); // ≥ 10%
  });

  it('treats the exact good threshold as good and the exact bad threshold as bad', () => {
    expect(rateLowerIsBetter(0.1, EU_SCOREBOARD.singleBidder)).toBe('good');
    expect(rateLowerIsBetter(0.2, EU_SCOREBOARD.singleBidder)).toBe('bad');
  });
});
