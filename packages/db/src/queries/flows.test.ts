import { describe, expect, it } from 'vitest';
import { fakeD1, type FakeD1 } from '@sigma/test-support';
import { getFlows } from './flows';

const pairRow = {
  authority_id: 'auth:000695089',
  bidder_id: 'eik:103267194',
  authority_name: 'Министерство на финансите',
  bidder_name: 'ТЕСТ ООД',
  bidder_kind: 'company' as const,
  bidder_legal_form: 'ООД',
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

describe('getFlows — privacy masking on the flows Sankey + top-pairs table (PR #183 review — lyubomir-bozhinov 2026-09-02, extended from the rows.ts:86 thread)', () => {
  // The flows mapper joins `flow_pairs` against `bidders` to recover `bidder_legal_form` (the rollup
  // table doesn't carry it — see the JOIN rationale in `topPairs` in flows.ts). The mapper then masks
  // sole-trader / natural-person pairs the same way `toCompanyListItem` + `toItem` (contract mapper)
  // do: opaque `m<base64(bidder_id)>` slug + „Частно лице" label + `masked: true` flag. The
  // `bidder_kind !== 'consortium'` guard preserves the consortium shape.

  const soleTraderRow = {
    authority_id: 'auth:1',
    bidder_id: 'eik:121817309',
    authority_name: 'Authority',
    bidder_name: 'ЕТ ДРИФТ - НИКОЛАЙ КИРОВ',
    bidder_kind: 'company' as const,
    bidder_legal_form: 'ЕТ',
    won_eur: 1000,
    contracts: 1,
  };
  const legalEntityRow = { ...pairRow };
  const consortiumRow = {
    ...pairRow,
    bidder_name: 'ЕТ Иван Петров; Строй ООД',
    bidder_kind: 'consortium' as const,
    bidder_legal_form: null,
  };

  function only(rows: object[]) {
    return fakeD1([
      { when: 'FROM sector_totals', all: [{ division: '45' }] },
      { when: 'FROM flow_pairs', all: rows },
      { when: 'FROM contracts c', all: rows },
    ]);
  }

  it('masks bidderName + bidderDisplayName for a sole trader (ЕТ, legal_form=ЕТ)', async () => {
    const data = await getFlows(only([soleTraderRow]).db, {});
    expect(data.pairs).toHaveLength(1);
    const pair = data.pairs[0]!;
    expect(pair.masked).toBe(true);
    expect(pair.bidderName).toBe('Частно лице');
    expect(pair.bidderDisplayName).toBe('Частно лице');
  });

  it('replaces bidderSlug with the opaque `m<base64(bidder_id)>` token for a sole trader', async () => {
    // The pre-fix `bidderSlug` was the bare ЕИК, leaking the natural-person ЕИК into the flows
    // page HTML payload and the .data RRv7 single-fetch turbo-stream. The opaque form mirrors the
    // invariant on /companies (`rows.ts:86`), the home top-10 (#9308672), and the home single-offer
    // + /contracts tables.
    const data = await getFlows(only([soleTraderRow]).db, {});
    const pair = data.pairs[0]!;
    expect(pair.bidderSlug.startsWith('m')).toBe(true);
    expect(pair.bidderSlug).not.toContain('121817309');
    expect(pair.bidderSlug).not.toMatch(/^\d{9}(\d{4})?$/);
  });

  it('drops the Sankey node `href` for a masked sole trader (non-resolvable opaque slug)', async () => {
    // The Sankey right-column bar is a navigation surface in the public flows view. A masked
    // bidder's opaque slug would 404 against the masked profile, which is reachable only via
    // direct URL or a noindexed contract-page backlink. The bar reads „Частно лице" and has no
    // href — a screen reader hears the label, a click does nothing.
    const data = await getFlows(only([soleTraderRow]).db, {});
    const maskedNode = data.sankey.nodes.find((n) => n.label === 'Частно лице');
    expect(maskedNode).toBeDefined();
    expect(maskedNode?.href).toBeUndefined();
    // The legal-entity case keeps its round-trippable href (the public flows view is still a
    // navigation surface for non-masked bidders).
    const legal = await getFlows(only([legalEntityRow]).db, {});
    const legalNode = legal.sankey.nodes.find((n) => n.side === 'company');
    expect(legalNode?.href).toMatch(/^\/companies\//);
  });

  it('keeps bidderSlug as the bare ЕИК for a legal entity (round-trippable)', async () => {
    const data = await getFlows(only([legalEntityRow]).db, {});
    const pair = data.pairs[0]!;
    expect(pair.masked).toBe(false);
    expect(pair.bidderSlug).toBe('103267194');
  });

  it('does NOT mask a consortium whose first member is a sole trader (MAJOR-class guard)', async () => {
    // The `bidder_kind !== 'consortium'` guard mirrors `toCompanyListItem`: a JV whose lead member
    // is a sole trader stays a legal entity, keeps its consortium ЕИК + „… и др." shape.
    const data = await getFlows(only([consortiumRow]).db, {});
    const pair = data.pairs[0]!;
    expect(pair.masked).toBe(false);
    expect(pair.bidderName).toBe('ЕТ Иван Петров; Строй ООД');
  });
});

describe('getFlows — funding scope and label truncation', () => {
  it('scopes the base aggregation by EU funding', async () => {
    const { db, sql } = spyFake();
    await getFlows(db, { funding: 'eu' });
    expect(sql.some((s) => s.includes('c.eu_funded = 1'))).toBe(true);
  });

  it('scopes the base aggregation by national funding', async () => {
    const { db, sql } = spyFake();
    await getFlows(db, { funding: 'national' });
    expect(sql.some((s) => s.includes('c.eu_funded IS NULL OR c.eu_funded = 0'))).toBe(true);
  });

  it('reads the rollup (not a scoped aggregation) when funding is explicitly „all"', async () => {
    const { db, sql } = spyFake();
    await getFlows(db, { funding: 'all' });
    expect(sql.some(usesFlowPairsRollup)).toBe(true);
    expect(sql.every((s) => !usesBaseAggregation(s))).toBe(true);
  });

  it('truncates a sankey node label longer than 30 chars with an ellipsis', async () => {
    const longName = 'Министерство на регионалното развитие и благоустройството';
    const data = await getFlows(fake([{ ...pairRow, authority_name: longName }]).db, {});
    const node = data.sankey.nodes.find((n) => n.side === 'authority')!;
    expect(node.label.length).toBeLessThanOrEqual(30);
    expect(node.label.endsWith('…')).toBe(true);
  });
});

describe('getFlows — sankey ordering', () => {
  it('orders the authority column by descending node total across two authorities', async () => {
    // Two DISTINCT authorities are needed for the authority-column `.sort()` comparator to run at all
    // (a single authority key never invokes it). The higher-total authority ranks to the top (index 0).
    const pairs = [
      {
        ...pairRow,
        authority_id: 'auth:small',
        authority_name: 'Малко ведомство',
        won_eur: 100000,
        bidder_id: 'eik:a',
      },
      {
        ...pairRow,
        authority_id: 'auth:big',
        authority_name: 'Голямо ведомство',
        won_eur: 900000,
        bidder_id: 'eik:b',
      },
    ];
    const data = await getFlows(fake(pairs).db, {});
    const auth = data.sankey.nodes.filter((n) => n.side === 'authority');
    expect(auth).toHaveLength(2);
    const big = auth.find((n) => n.label.startsWith('Голямо'))!;
    const small = auth.find((n) => n.label.startsWith('Малко'))!;
    expect(big.y).toBeLessThan(small.y); // bigger total sits higher in the column
  });

  it('orders ribbons by company rank when two pairs share an authority (sort tiebreak)', async () => {
    // Input is deliberately NOT in rank order (Бета before the bigger Алфа) so the comparator has to
    // reorder: ribbons must come out in company-node order (Алфа's node ranks above Бета's by value).
    // Without the `.sort()` the ribbons would keep input order — this assertion discriminates it.
    const pairs = [
      { ...pairRow, bidder_id: 'eik:222', bidder_name: 'Бета ООД', won_eur: 200000, contracts: 3 },
      { ...pairRow, bidder_id: 'eik:111', bidder_name: 'Алфа ООД', won_eur: 300000, contracts: 5 },
    ];
    const data = await getFlows(fake(pairs).db, {});
    expect(data.sankey.ribbons.map((r) => r.toName)).toEqual(['Алфа ООД', 'Бета ООД']);
    expect(data.sankey.nodes.filter((n) => n.side === 'authority')).toHaveLength(1);
    expect(data.sankey.nodes.filter((n) => n.side === 'company')).toHaveLength(2);
  });
});
