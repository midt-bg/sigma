import { describe, expect, it } from 'vitest';
import {
  BG_REGIONS,
  CLASSIFIED_PROCEDURE_TYPES,
  CPV_CATEGORIES,
  CPV_SECTORS,
  ENTITY_TYPES,
  EU_SCOREBOARD,
  NON_COMPETITIVE_PROCEDURE_TYPES,
  PROCEDURE_GROUPS,
  PROCEDURE_UNKNOWN_KEY,
  categoryForDivision,
  procedureGroup,
  rateLowerIsBetter,
  regionByName,
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

  it('rates the entire open interval between the bands as mid', () => {
    // Any value strictly inside (good, bad) must be 'mid' — the middle branch,
    // exercised just above good and just below bad so a `<`/`<=` flip is caught.
    expect(rateLowerIsBetter(0.101, EU_SCOREBOARD.singleBidder)).toBe('mid');
    expect(rateLowerIsBetter(0.199, EU_SCOREBOARD.singleBidder)).toBe('mid');
    expect(rateLowerIsBetter(0.0501, EU_SCOREBOARD.directAward)).toBe('mid');
    expect(rateLowerIsBetter(0.0999, EU_SCOREBOARD.directAward)).toBe('mid');
  });
});

describe('categoryForDivision (edge inputs)', () => {
  it('returns null for values with no leading digits after non-digit stripping', () => {
    // Truthy strings that reduce to '' after \D removal must miss the map, not throw.
    expect(categoryForDivision('   ')).toBeNull();
    expect(categoryForDivision('abc')).toBeNull();
    expect(categoryForDivision('-')).toBeNull();
  });

  it('reads the division from the first two digits only, ignoring the rest', () => {
    // '45' resolves; the trailing digits/letters of a full CPV code are irrelevant.
    expect(categoryForDivision('45')?.key).toBe('construction');
    expect(categoryForDivision('4599zzz')?.key).toBe('construction');
    // A separator before the division must not shift the 2-digit window: \D is stripped first.
    expect(categoryForDivision('CPV-45')?.key).toBe('construction');
  });

  it('returns null for a well-formed division that is not in any category', () => {
    expect(categoryForDivision('01')).toBeNull(); // no such division in CPV_CATEGORIES
    expect(categoryForDivision(undefined)).toBeNull();
  });
});

describe('procedureGroup (edge inputs)', () => {
  it('trims surrounding whitespace before lookup', () => {
    expect(procedureGroup('  Пряко договаряне  ').key).toBe('direct');
    expect(procedureGroup('\tОткрита процедура\n').key).toBe('open');
  });

  it('falls back via the exported key constant, not a hard-coded literal', () => {
    // A value that is only whitespace is falsy after trim? No — it is truthy, so it
    // takes the map-miss path, still landing on the unknown bucket.
    expect(procedureGroup('   ').key).toBe(PROCEDURE_UNKNOWN_KEY);
    expect(procedureGroup(undefined).key).toBe(PROCEDURE_UNKNOWN_KEY);
    expect(procedureGroup(null).key).toBe(PROCEDURE_UNKNOWN_KEY);
    expect(PROCEDURE_UNKNOWN_KEY).toBe('unknown');
  });
});

describe('regionByName', () => {
  it('resolves an authority region name to its NUTS3 region', () => {
    expect(regionByName('София (столица)')).toMatchObject({
      nuts3: 'BG411',
      name: 'София (столица)',
      nuts2: 'BG41',
      nuts2Name: 'Югозападен',
    });
    expect(regionByName('Пловдив')?.nuts3).toBe('BG421');
    // The two same-named-stem regions must stay distinct.
    expect(regionByName('София')?.nuts3).toBe('BG412');
  });

  it('trims surrounding whitespace before matching', () => {
    expect(regionByName('  Варна  ')?.nuts3).toBe('BG331');
    expect(regionByName('\nБургас\t')?.nuts3).toBe('BG341');
  });

  it('returns null for missing, empty, or unknown names', () => {
    expect(regionByName(null)).toBeNull();
    expect(regionByName(undefined)).toBeNull();
    expect(regionByName('')).toBeNull();
    expect(regionByName('Атлантида')).toBeNull();
    // A trailing space around an unknown name still misses, not throws.
    expect(regionByName('  Няма такъв  ')).toBeNull();
  });

  it('round-trips every configured region through its verbatim name', () => {
    for (const region of BG_REGIONS) {
      expect(regionByName(region.name)).toBe(region);
    }
  });
});

// ── Taxonomy integrity: these guard the deterministic maps the whole app trusts.
// A duplicate key or a broken partition here silently mis-classifies contracts, so
// each invariant is asserted, not assumed. ──────────────────────────────────────────
describe('taxonomy integrity', () => {
  it('CPV_SECTORS has 45 unique 2-digit division codes in ascending order', () => {
    const codes = CPV_SECTORS.map((s) => s.code);
    expect(codes).toHaveLength(45);
    expect(new Set(codes).size).toBe(45);
    expect([...codes]).toEqual([...codes].sort());
    for (const code of codes) expect(code).toMatch(/^\d{2}$/);
  });

  it('every curated sector carries a short display name', () => {
    for (const sector of CPV_SECTORS.filter((s) => s.curated)) {
      expect(sector.short, `curated ${sector.code} needs a short name`).toBeTruthy();
    }
    expect(
      CPV_SECTORS.filter((s) => s.curated)
        .map((s) => s.code)
        .sort(),
    ).toEqual(['15', '45']);
  });

  it('CPV_CATEGORIES keys are unique and every division is a known sector', () => {
    const keys = CPV_CATEGORIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    const sectorCodes = new Set(CPV_SECTORS.map((s) => s.code));
    for (const category of CPV_CATEGORIES) {
      for (const division of category.divisions) {
        expect(sectorCodes.has(division), `division ${division} is not a CPV sector`).toBe(true);
      }
    }
  });

  it('PROCEDURE_GROUPS assign each procedure type to exactly one group', () => {
    const seen = new Map<string, string>();
    for (const group of PROCEDURE_GROUPS) {
      expect(group.types.length, `group ${group.key} has no types`).toBeGreaterThan(0);
      expect(group.color, `group ${group.key} has no colour`).toBeTruthy();
      for (const type of group.types) {
        expect(seen.has(type), `type "${type}" is in two groups`).toBe(false);
        seen.set(type, group.key);
      }
    }
    // group keys are unique too
    const keys = PROCEDURE_GROUPS.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('classified types are exactly the competitive ∪ non-competitive types, no neutrals', () => {
    const competitiveTypes = PROCEDURE_GROUPS.filter((g) => g.competitive !== null).flatMap(
      (g) => g.types,
    );
    expect([...CLASSIFIED_PROCEDURE_TYPES].sort()).toEqual([...competitiveTypes].sort());
    // The direct-award list is precisely the competitive===false types.
    const nonCompetitive = PROCEDURE_GROUPS.filter((g) => g.competitive === false).flatMap(
      (g) => g.types,
    );
    expect([...NON_COMPETITIVE_PROCEDURE_TYPES].sort()).toEqual([...nonCompetitive].sort());
  });

  it('BG_REGIONS has 28 областти with unique NUTS3 ids and names', () => {
    expect(BG_REGIONS).toHaveLength(28);
    expect(new Set(BG_REGIONS.map((r) => r.nuts3)).size).toBe(28);
    expect(new Set(BG_REGIONS.map((r) => r.name)).size).toBe(28);
    for (const region of BG_REGIONS) {
      expect(region.nuts3).toMatch(/^BG\d{3}$/);
      expect(region.nuts2).toMatch(/^BG\d{2}$/);
      expect(region.nuts3.startsWith(region.nuts2)).toBe(true);
    }
  });

  it('ENTITY_TYPES labels both real bidder kinds', () => {
    expect(Object.keys(ENTITY_TYPES).sort()).toEqual(['company', 'consortium']);
    expect(ENTITY_TYPES.company).toBeTruthy();
    expect(ENTITY_TYPES.consortium).toBeTruthy();
  });
});
