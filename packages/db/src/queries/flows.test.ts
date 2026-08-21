import { describe, expect, it } from 'vitest';
import { fakeD1, type FakeD1 } from '@sigma/test-support';
import { getFlows } from './flows';

const pairRow = {
  authority_id: 'auth:000695089',
  bidder_id: 'eik:103267194',
  authority_name: 'Министерство на финансите',
  bidder_name: 'ТЕСТ ООД',
  bidder_kind: 'company' as const,
  won_eur: 500000,
  contracts: 10,
};

// getFlows picks its source from the active filters (see flows.ts `topPairs`): the precomputed
// `flow_pairs` rollup top-N for an unfiltered view, a scoped base aggregation over `contracts` once a
// sector/year/funding filter is set. There's no real D1 here, so the branch-selection tests pin that
// choice by matching the table source (and the year predicate) in the prepared SQL. Naming the markers
// keeps the assertions reading as intent rather than raw query text, and localises any future change.
const usesFlowPairsRollup = (sql: string) => sql.includes('FROM flow_pairs');
const usesBaseAggregation = (sql: string) => sql.includes('FROM contracts c');
const filtersByYear = (sql: string) => sql.includes('substr(c.signed_at, 1, 4) = ?');

// The two shapes the pair query can take — the flow_pairs rollup, and the base aggregation a filter
// switches it to — plus the sector-filter dropdown, which no test here asserts on.
function fake(rows: (typeof pairRow)[] = [pairRow]): FakeD1 {
  return fakeD1([
    { when: 'FROM sector_totals', all: [{ division: '45' }] },
    { when: 'FROM flow_pairs', all: rows },
    { when: 'FROM contracts c', all: rows },
  ]);
}

function spyFake(): FakeD1 {
  return fakeD1([
    { when: 'FROM sector_totals', all: [] },
    { when: 'FROM flow_pairs', all: [pairRow] },
    { when: 'FROM contracts c', all: [pairRow] },
  ]);
}

describe('getFlows', () => {
  it('uses the flow_pairs rollup for an unfiltered request', async () => {
    const { db, sql } = spyFake();

    await getFlows(db, {});

    expect(sql.some(usesFlowPairsRollup)).toBe(true);
    expect(sql.every((s) => !usesBaseAggregation(s))).toBe(true);
  });

  it('falls back to a base aggregation when a sector filter is applied', async () => {
    const { db, sql } = spyFake();

    await getFlows(db, { sector: '45' });

    expect(sql.some(usesBaseAggregation)).toBe(true);
  });

  it('falls back to a base aggregation when a year filter is applied', async () => {
    const { db, sql } = spyFake();

    await getFlows(db, { year: '2024' });

    expect(sql.some(filtersByYear)).toBe(true);
  });

  it('returns pairs with rank, slugs, names, and amounts', async () => {
    const data = await getFlows(fake().db, {});

    expect(data.pairs).toHaveLength(1);
    const pair = data.pairs[0]!;
    expect(pair.rank).toBe(1);
    expect(pair.authoritySlug).toBe('000695089');
    expect(pair.bidderSlug).toBe('103267194');
    expect(pair.wonEur).toBe(500000);
    expect(pair.contracts).toBe(10);
  });

  it('returns a sankey layout with nodes and ribbons', async () => {
    const data = await getFlows(fake().db, {});

    expect(data.sankey.nodes.length).toBeGreaterThan(0);
    expect(data.sankey.ribbons).toHaveLength(1);
    expect(typeof data.sankey.viewBox).toBe('string');
  });

  it('assigns each node a side ("authority" or "company") and a valid href', async () => {
    const data = await getFlows(fake().db, {});

    const authorityNode = data.sankey.nodes.find((n) => n.side === 'authority');
    const companyNode = data.sankey.nodes.find((n) => n.side === 'company');

    expect(authorityNode).toBeDefined();
    expect(authorityNode?.href).toMatch(/^\/authorities\//);
    expect(companyNode).toBeDefined();
    expect(companyNode?.href).toMatch(/^\/companies\//);
  });

  it('returns an empty sankey for an empty pair set', async () => {
    const data = await getFlows(fake([]).db, {});

    expect(data.pairs).toHaveLength(0);
    expect(data.sankey.nodes).toHaveLength(0);
    expect(data.sankey.ribbons).toHaveLength(0);
  });

  it('clamps the top parameter to 20 or 50', async () => {
    const data20 = await getFlows(fake().db, { top: 20 });
    const data50 = await getFlows(fake().db, { top: 50 });
    const dataDefault = await getFlows(fake().db, {});
    const dataOther = await getFlows(fake().db, { top: 100 });

    expect(data20.scope.top).toBe(20);
    expect(data50.scope.top).toBe(50);
    expect(dataDefault.scope.top).toBe(20);
    expect(dataOther.scope.top).toBe(20);
  });

  it('includes available sectors in the response', async () => {
    const data = await getFlows(fake().db, {});

    expect(Array.isArray(data.sectors)).toBe(true);
  });
});
