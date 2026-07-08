import { describe, expect, it } from 'vitest';
import { CPV_CATEGORIES, CPV_SECTORS, categoryForDivision, procedureGroup } from './index';

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
