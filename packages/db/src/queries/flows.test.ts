import { describe, expect, it } from 'vitest';
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

function fakeDb(rows: (typeof pairRow)[] = [pairRow]): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async all<T>() {
          if (sql.includes('sector_totals')) {
            return { results: [{ division: '45' }] as T[] };
          }
          return { results: rows as T[] };
        },
      };
    },
  } as D1Database;
}

// SQL-capturing fake DB for the branch-selection tests: records every prepared statement, returns no
// available sectors and a single flow pair otherwise — enough to assert which source query ran.
function spyDb(): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const db = {
    prepare(q: string) {
      sql.push(q);
      return {
        bind() {
          return this;
        },
        async all<T>() {
          if (q.includes('sector_totals')) return { results: [] as T[] };
          return { results: [pairRow] as T[] };
        },
      };
    },
  } as D1Database;
  return { db, sql };
}

describe('getFlows', () => {
  it('uses the flow_pairs rollup for an unfiltered request', async () => {
    const { db, sql } = spyDb();

    await getFlows(db, {});

    expect(sql.some(usesFlowPairsRollup)).toBe(true);
    expect(sql.every((s) => !usesBaseAggregation(s))).toBe(true);
  });

  it('falls back to a base aggregation when a sector filter is applied', async () => {
    const { db, sql } = spyDb();

    await getFlows(db, { sector: '45' });

    expect(sql.some(usesBaseAggregation)).toBe(true);
  });

  it('falls back to a base aggregation when a year filter is applied', async () => {
    const { db, sql } = spyDb();

    await getFlows(db, { year: '2024' });

    expect(sql.some(filtersByYear)).toBe(true);
  });

  it('returns pairs with rank, slugs, names, and amounts', async () => {
    const data = await getFlows(fakeDb(), {});

    expect(data.pairs).toHaveLength(1);
    const pair = data.pairs[0]!;
    expect(pair.rank).toBe(1);
    expect(pair.authoritySlug).toBe('000695089');
    expect(pair.bidderSlug).toBe('103267194');
    expect(pair.wonEur).toBe(500000);
    expect(pair.contracts).toBe(10);
  });

  it('returns a sankey layout with nodes and ribbons', async () => {
    const data = await getFlows(fakeDb(), {});

    expect(data.sankey.nodes.length).toBeGreaterThan(0);
    expect(data.sankey.ribbons).toHaveLength(1);
    expect(typeof data.sankey.viewBox).toBe('string');
  });

  it('assigns each node a side ("authority" or "company") and a valid href', async () => {
    const data = await getFlows(fakeDb(), {});

    const authorityNode = data.sankey.nodes.find((n) => n.side === 'authority');
    const companyNode = data.sankey.nodes.find((n) => n.side === 'company');

    expect(authorityNode).toBeDefined();
    expect(authorityNode?.href).toMatch(/^\/authorities\//);
    expect(companyNode).toBeDefined();
    expect(companyNode?.href).toMatch(/^\/companies\//);
  });

  it('returns an empty sankey for an empty pair set', async () => {
    const data = await getFlows(fakeDb([]), {});

    expect(data.pairs).toHaveLength(0);
    expect(data.sankey.nodes).toHaveLength(0);
    expect(data.sankey.ribbons).toHaveLength(0);
  });

  it('clamps the top parameter to 20 or 50', async () => {
    const data20 = await getFlows(fakeDb(), { top: 20 });
    const data50 = await getFlows(fakeDb(), { top: 50 });
    const dataDefault = await getFlows(fakeDb(), {});
    const dataOther = await getFlows(fakeDb(), { top: 100 });

    expect(data20.scope.top).toBe(20);
    expect(data50.scope.top).toBe(50);
    expect(dataDefault.scope.top).toBe(20);
    expect(dataOther.scope.top).toBe(20);
  });

  it('includes available sectors in the response', async () => {
    const data = await getFlows(fakeDb(), {});

    expect(Array.isArray(data.sectors)).toBe(true);
  });
});
