import { describe, expect, it } from 'vitest';
import {
  CPV_BUCKET_GOODS,
  CPV_BUCKET_SERVICES,
  CPV_BUCKET_WORKS,
  CPV_CATEGORIES,
  CPV_SECTORS,
  categoryForDivision,
  cpvBucket,
  cpvDivision,
  procedureGroup,
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

describe('cpvBucket', () => {
  it('classifies the construction-works division as works', () => {
    expect(cpvBucket('45')).toBe('works');
    expect(cpvBucket('45233120-6')).toBe('works'); // full code → division 45
  });

  it('classifies the service divisions as services', () => {
    for (const code of ['50', '71', '72', '85', '90', '98']) {
      expect(cpvBucket(code)).toBe('services');
    }
  });

  it('classifies the remaining catalogued divisions as goods', () => {
    for (const code of ['15', '30', '33', '34', '43', '44', '48']) {
      expect(cpvBucket(code)).toBe('goods'); // 44 (building materials) is a supply, not works
    }
    expect(cpvBucket('44210000')).toBe('goods'); // full code → division 44
  });

  it('falls back to other for missing or out-of-taxonomy codes', () => {
    expect(cpvBucket(null)).toBe('other');
    expect(cpvBucket('')).toBe('other');
    expect(cpvBucket('99')).toBe('other');
  });

  it('assigns every catalogued division to exactly one real bucket (a partition)', () => {
    for (const sector of CPV_SECTORS) {
      expect(['works', 'goods', 'services']).toContain(cpvBucket(sector.code));
    }
  });

  it('never leaves a catalogued division on the default „other" bucket', () => {
    // Guard: a future service division added to CPV_SECTORS but not to CPV_BUCKET_SERVICES would
    // silently fall through to „goods" — but one added entirely outside the bucket sets (none today)
    // would land on „other". Every catalogued code MUST resolve to a real bucket, never the fallback.
    for (const sector of CPV_SECTORS) {
      expect(cpvBucket(sector.code)).not.toBe('other');
    }
  });

  it('partitions CPV_DIVISION_SET exactly across works ∪ goods ∪ services', () => {
    // The bucket sets must be a partition of every catalogued division — not just individually
    // non-empty. A future service division added to CPV_SECTORS but forgotten in CPV_BUCKET_SERVICES
    // would previously fall through to CPV_BUCKET_GOODS silently (goods was "everything else"); with
    // an explicit goods set, that division now belongs to none of the three sets and this test fails
    // instead of shipping a mis-bucketed division.
    const sectorCodes = new Set(CPV_SECTORS.map((sector) => sector.code));
    const union = new Set([...CPV_BUCKET_WORKS, ...CPV_BUCKET_GOODS, ...CPV_BUCKET_SERVICES]);

    expect(union).toEqual(sectorCodes);

    const totalMembers = CPV_BUCKET_WORKS.size + CPV_BUCKET_GOODS.size + CPV_BUCKET_SERVICES.size;
    expect(totalMembers).toBe(union.size); // no division counted in more than one bucket
  });
});

describe('cpvDivision', () => {
  it('normalises a full code, a 2-digit division and a check-digit suffix to the division', () => {
    expect(cpvDivision('45233120-6')).toBe('45');
    expect(cpvDivision('45')).toBe('45');
    expect(cpvDivision('15800000')).toBe('15');
  });

  it('strips non-digits before taking the prefix so dirty codes still resolve', () => {
    expect(cpvDivision('4-5233110')).toBe('45'); // stray separator inside the prefix
    expect(cpvDivision(' 45')).toBe('45'); // leading whitespace
    expect(cpvDivision('45.23')).toBe('45');
  });

  it('returns an empty string for a missing or digit-less code', () => {
    expect(cpvDivision(null)).toBe('');
    expect(cpvDivision(undefined)).toBe('');
    expect(cpvDivision('')).toBe('');
    expect(cpvDivision('—')).toBe('');
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
