import { describe, expect, it } from 'vitest';
import { fakeD1, type FakeD1 } from '@sigma/test-support';
import { getRegionalSpending } from './regions';

// Fake D1 keyed by SQL markers (same approach as competition.test.ts). Verifies the JS-side
// aggregation: region name -> NUTS3 mapping, the always-28 zero-fill, the unattributed bucket,
// coverage, the NUTS2 macro rollup, and that a filter switches from the authority_totals rollup to
// base aggregation.

const ROWS = [
  { region: 'Пловдив', value_eur: 5000, contracts: 50, authorities: 10 },
  { region: 'Бургас', value_eur: 3000, contracts: 30, authorities: 6 },
  { region: 'Несъществуваща област', value_eur: 100, contracts: 1, authorities: 1 }, // unknown -> unattributed
  { region: null, value_eur: 2000, contracts: 20, authorities: 8 }, // NULL -> unattributed
];

// Both shapes the query can take: the authority_totals rollup, and the base aggregation a filter
// switches it to. Each is its own route, so losing either one is a failure rather than a fallback.
function fake(): FakeD1 {
  return fakeD1([
    { when: 'FROM authority_totals GROUP BY region', all: ROWS },
    { when: 'JOIN authorities a', all: ROWS },
    // getRegionalSpending also fetches the sector-filter options. Nothing here asserts on them, so
    // the answer is explicitly no divisions — which is what the old double produced by accident,
    // since it served region rows to this query and sectorOptions filtered every one away.
    { when: 'FROM sector_totals', all: [] },
  ]);
}

describe('getRegionalSpending', () => {
  it('returns all 28 regions, sorted by value, with the top mapped to its NUTS3', async () => {
    const { regions } = await getRegionalSpending(fake().db, {});
    expect(regions).toHaveLength(28);
    expect(regions[0]).toMatchObject({ name: 'Пловдив', nuts3: 'BG421', valueEur: 5000 });
    expect(regions[1]).toMatchObject({ name: 'Бургас', nuts3: 'BG341', valueEur: 3000 });
    // a region with no rows is present and zero-filled
    expect(regions.find((r) => r.nuts3 === 'BG311')).toMatchObject({ name: 'Видин', valueEur: 0 });
  });

  it('folds NULL and unknown regions into the unattributed bucket', async () => {
    const { unattributed } = await getRegionalSpending(fake().db, {});
    expect(unattributed).toEqual({ valueEur: 2100, contracts: 21, authorities: 9 });
  });

  it('reports coverage as the share of authorities with a known region', async () => {
    const { coverage } = await getRegionalSpending(fake().db, {});
    expect(coverage.withRegion).toBe(16); // 10 + 6
    expect(coverage.total).toBe(25); // 16 + 9 unattributed
    expect(coverage.pct).toBeCloseTo(16 / 25);
  });

  it('rolls regions up into NUTS2 macro-regions', async () => {
    const { macroRegions } = await getRegionalSpending(fake().db, {});
    expect(macroRegions[0]).toMatchObject({
      nuts2: 'BG42',
      name: 'Южен централен',
      valueEur: 5000,
    });
    expect(macroRegions.find((m) => m.nuts2 === 'BG34')).toMatchObject({ valueEur: 3000 });
  });

  it('reads authority_totals unfiltered, but aggregates from base tables when filtered', async () => {
    const unfiltered = fake();
    await getRegionalSpending(unfiltered.db, {});
    expect(unfiltered.sql.some((s) => s.includes('FROM authority_totals'))).toBe(true);

    const filtered = fake();
    await getRegionalSpending(filtered.db, { sector: '45' });
    expect(filtered.sql.some((s) => s.includes('FROM authority_totals'))).toBe(false);
    expect(filtered.sql.some((s) => s.includes('JOIN tenders t'))).toBe(true);
  });
});

describe('getRegionalSpending — empty dataset', () => {
  it('reports zero coverage without dividing by zero when no authorities exist', async () => {
    // No region rows at all → withRegion 0 and unattributed 0 → total 0 → the `total > 0 ? … : 0`
    // else-branch owns pct (guards against 0/0 = NaN).
    const empty = fakeD1([
      { when: 'FROM authority_totals GROUP BY region', all: [] },
      { when: 'FROM sector_totals', all: [] },
    ]);
    const { coverage } = await getRegionalSpending(empty.db, {});
    expect(coverage.total).toBe(0);
    expect(coverage.pct).toBe(0);
  });
});

describe('getRegionalSpending — filter predicates', () => {
  it('applies the year filter via base aggregation, not the rollup', async () => {
    const cap = fake();
    await getRegionalSpending(cap.db, { year: '2025' });
    expect(cap.sql.some((s) => s.includes('substr(c.signed_at, 1, 4) = ?'))).toBe(true);
    expect(cap.sql.some((s) => s.includes('FROM authority_totals'))).toBe(false);
  });
  it('applies the EU funding predicate', async () => {
    const cap = fake();
    await getRegionalSpending(cap.db, { funding: 'eu' });
    expect(cap.sql.some((s) => s.includes('c.eu_funded = 1'))).toBe(true);
  });
  it('applies the national (non-EU) funding predicate', async () => {
    const cap = fake();
    await getRegionalSpending(cap.db, { funding: 'national' });
    expect(cap.sql.some((s) => s.includes('c.eu_funded IS NULL OR c.eu_funded = 0'))).toBe(true);
  });
});
