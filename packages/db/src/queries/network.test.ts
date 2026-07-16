import { describe, expect, it } from 'vitest';
import { getEntityCounterparties, getEntityNetwork } from './network';

// Fake D1 keyed by SQL markers (same approach as the other query tests). Verifies the ego-network
// shaping: centre + hop-1 neighbours + hop-2 (top-1 other per neighbour), node de-duplication, the
// authority/company direction, and that node weight is the sum of incident edges.

const PICKER_AUTH = [
  { authority_id: 'auth:C', name: 'Център Институция' },
  { authority_id: 'auth:X', name: 'Друга Институция' },
];
const PICKER_COMP = [{ bidder_id: 'eik:A', name: 'Фирма А', kind: 'company' }];
const CENTER_AUTH = { name: 'Център Институция', spent_eur: 100000 };
const HOP1 = [
  {
    authority_id: 'auth:C',
    bidder_id: 'eik:A',
    authority_name: 'Център Институция',
    bidder_name: 'Фирма А',
    bidder_kind: 'company',
    won_eur: 5000,
    contracts: 5,
  },
  {
    authority_id: 'auth:C',
    bidder_id: 'eik:B',
    authority_name: 'Център Институция',
    bidder_name: 'Фирма Б',
    bidder_kind: 'company',
    won_eur: 3000,
    contracts: 3,
  },
];
// Both hop-1 companies also work for auth:X -> auth:X is a shared hop-2 node (deduped to one).
const HOP2 = [
  {
    authority_id: 'auth:X',
    bidder_id: 'eik:A',
    authority_name: 'Друга Институция',
    bidder_name: 'Фирма А',
    bidder_kind: 'company',
    won_eur: 2000,
    contracts: 2,
  },
  {
    authority_id: 'auth:X',
    bidder_id: 'eik:B',
    authority_name: 'Друга Институция',
    bidder_name: 'Фирма Б',
    bidder_kind: 'company',
    won_eur: 1500,
    contracts: 1,
  },
];

// Counterparties of a COMPANY centre (eik:A): the authorities that paid it, ordered by won_eur desc.
const COMP_COUNTERPARTIES = [
  {
    authority_id: 'auth:C',
    bidder_id: 'eik:A',
    authority_name: 'Център Институция',
    bidder_name: 'Фирма А',
    bidder_kind: 'company',
    won_eur: 5000,
    contracts: 5,
  },
  {
    authority_id: 'auth:X',
    bidder_id: 'eik:A',
    authority_name: 'Друга Институция',
    bidder_name: 'Фирма А',
    bidder_kind: 'company',
    won_eur: 2000,
    contracts: 2,
  },
];

// COUNT(*) returns no row (D1 error) instead of the usual { n: 42 } — used to assert the fallback
// stays `null` ("unknown") rather than masking the failure as the HOP1 draw cap.
function fakeDbCountFails(): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async all<T>() {
          if (sql.includes('ORDER BY spent_eur')) return { results: PICKER_AUTH as T[] };
          if (sql.includes('FROM company_totals')) return { results: PICKER_COMP as T[] };
          if (sql.includes('FROM flow_pairs WHERE authority_id = ?'))
            return { results: HOP1 as T[] };
          if (sql.includes('WHERE bidder_id IN')) return { results: HOP2 as T[] };
          return { results: [] as T[] };
        },
        async first<T>() {
          if (sql.includes('FROM authority_totals WHERE authority_id')) return CENTER_AUTH as T;
          if (sql.includes('COUNT(*)')) return null as T;
          return null as T;
        },
      };
    },
  } as unknown as D1Database;
}

function fakeDb(): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async all<T>() {
          if (sql.includes('ORDER BY spent_eur')) return { results: PICKER_AUTH as T[] };
          if (sql.includes('FROM company_totals')) return { results: PICKER_COMP as T[] };
          // The counterparties keyset query tiebreaks on the neighbour id column: for an authority
          // centre that is "won_eur DESC, bidder_id"; for a COMPANY centre it is "won_eur DESC,
          // authority_id" (the other ORDER BY the reviewer flagged as untested). The hop-1 graph read
          // orders by "won_eur DESC LIMIT" (no id tiebreak).
          if (sql.includes('won_eur DESC, authority_id'))
            return { results: COMP_COUNTERPARTIES as T[] };
          if (sql.includes('won_eur DESC, bidder_id')) return { results: HOP1 as T[] };
          if (sql.includes('FROM flow_pairs WHERE authority_id = ?'))
            return { results: HOP1 as T[] };
          if (sql.includes('WHERE bidder_id IN')) return { results: HOP2 as T[] };
          return { results: [] as T[] };
        },
        async first<T>() {
          if (sql.includes('FROM authority_totals WHERE authority_id')) return CENTER_AUTH as T;
          if (sql.includes('COUNT(*)')) return { n: 42 } as T;
          return null as T;
        },
      };
    },
  } as unknown as D1Database;
}

// The centre-load fails (no name in authority_totals AND no HOP1 sample to fall back to) while
// COUNT(*) still succeeds with a real, non-zero total — used to assert the early-exit at the
// `!center` branch preserves that already-computed total instead of fabricating 0.
function fakeDbCenterLoadFails(): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async all<T>() {
          if (sql.includes('ORDER BY spent_eur')) return { results: PICKER_AUTH as T[] };
          if (sql.includes('FROM company_totals')) return { results: PICKER_COMP as T[] };
          if (sql.includes('FROM flow_pairs WHERE authority_id = ?')) return { results: [] as T[] };
          return { results: [] as T[] };
        },
        async first<T>() {
          if (sql.includes('FROM authority_totals WHERE authority_id')) return null as T;
          if (sql.includes('COUNT(*)')) return { n: 7 } as T;
          return null as T;
        },
      };
    },
  } as unknown as D1Database;
}

// No authority has any flows at all: the `!top` early-exit before a centre is even chosen. This is
// a real, known zero (not a centre-load failure) and must stay the literal `0`.
function fakeDbNoAuthorities(): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async first<T>() {
          return null as T;
        },
      };
    },
  } as unknown as D1Database;
}

describe('getEntityNetwork', () => {
  it('builds the centre, hop-1 neighbours and a deduped hop-2 ring', async () => {
    const { center, nodes, edges } = await getEntityNetwork(fakeDb(), {
      kind: 'authority',
      id: 'auth:C',
    });
    expect(center).toMatchObject({ id: 'auth:C', kind: 'authority', label: 'Център Институция' });
    // auth:C (centre) + eik:A, eik:B (hop 1) + auth:X (hop 2, shared by both -> one node)
    expect(nodes.map((n) => n.id).sort()).toEqual(['auth:C', 'auth:X', 'eik:A', 'eik:B']);
    expect(edges).toHaveLength(4); // C->A, C->B, A->X, B->X
  });

  it('alternates kinds by hop (authority centre -> company hop1 -> authority hop2)', async () => {
    const { nodes } = await getEntityNetwork(fakeDb(), { kind: 'authority', id: 'auth:C' });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get('eik:A')).toMatchObject({ kind: 'company', hop: 1 });
    expect(byId.get('auth:X')).toMatchObject({ kind: 'authority', hop: 2 });
  });

  it('weights each node by the sum of its incident edges', async () => {
    const { nodes } = await getEntityNetwork(fakeDb(), { kind: 'authority', id: 'auth:C' });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get('auth:C')!.valueEur).toBe(8000); // 5000 + 3000
    expect(byId.get('auth:X')!.valueEur).toBe(3500); // 2000 + 1500
  });

  it('offers centre options for the picker', async () => {
    const { centerOptions } = await getEntityNetwork(fakeDb(), { kind: 'authority', id: 'auth:C' });
    expect(centerOptions.authorities.length).toBeGreaterThan(0);
    expect(centerOptions.authorities[0]).toMatchObject({ kind: 'authority', value: 'a:C' });
  });

  it('reports the full counterparty count, not just the drawn cap', async () => {
    const { counterpartyTotal } = await getEntityNetwork(fakeDb(), {
      kind: 'authority',
      id: 'auth:C',
    });
    expect(counterpartyTotal).toBe(42); // COUNT(*) over flow_pairs, not the HOP1 cap (2 drawn)
  });

  it('reports counterpartyTotal as null (not the HOP1 cap) when COUNT(*) fails', async () => {
    const { counterpartyTotal } = await getEntityNetwork(fakeDbCountFails(), {
      kind: 'authority',
      id: 'auth:C',
    });
    expect(counterpartyTotal).toBeNull(); // must stay "unknown", never fabricated as hop1.length (2)
  });

  it('preserves the already-computed counterpartyTotal (not a fabricated 0) when the centre fails to load', async () => {
    const result = await getEntityNetwork(fakeDbCenterLoadFails(), {
      kind: 'authority',
      id: 'auth:GHOST',
    });
    expect(result.center).toBeNull();
    expect(result.counterpartyTotal).toBe(7); // the real COUNT(*), not the literal 0
  });

  it('still returns a real 0 when no authority has any flows at all (the legitimate !top zero)', async () => {
    const result = await getEntityNetwork(fakeDbNoAuthorities(), null);
    expect(result.center).toBeNull();
    expect(result.counterpartyTotal).toBe(0);
  });
});

describe('getEntityCounterparties', () => {
  it('returns the full count and normalises rows to authority -> company', async () => {
    const page = await getEntityCounterparties(fakeDb(), { kind: 'authority', id: 'auth:C' });
    expect(page.total).toBe(42);
    expect(page.rows[0]).toMatchObject({
      authorityLabel: 'Център Институция',
      authoritySlug: 'C',
      companyLabel: 'Фирма А',
      companySlug: 'A',
      valueEur: 5000,
      contracts: 5,
    });
  });

  it('emits a next cursor when more rows exist than fit on the page', async () => {
    // The fake returns 2 rows; pageSize 1 means an extra row is seen -> there is a next page.
    const page = await getEntityCounterparties(
      fakeDb(),
      { kind: 'authority', id: 'auth:C' },
      { pageSize: 1 },
    );
    expect(page.rows).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
  });

  it('handles a company centre (other neighbour column + ORDER BY)', async () => {
    // Company centre keysets on authority_id, not bidder_id — exercises the previously-untested path.
    const page = await getEntityCounterparties(fakeDb(), { kind: 'company', id: 'eik:A' });
    expect(page.rows).toHaveLength(2);
    expect(page.rows.map((r) => r.authoritySlug)).toEqual(['C', 'X']);
    expect(page.rows[0]).toMatchObject({ companySlug: 'A', valueEur: 5000 });
  });

  it('reuses a caller-supplied total instead of a second COUNT(*)', async () => {
    // The /network route passes the count getEntityNetwork already ran (avoids a duplicate D1 scan).
    const page = await getEntityCounterparties(
      fakeDb(),
      { kind: 'authority', id: 'auth:C' },
      { total: 7 },
    );
    expect(page.total).toBe(7); // the passed value, not the fake's COUNT(*) sentinel (42)
  });

  it('reports total as null (not 0) when COUNT(*) fails — consistent with getEntityNetwork', async () => {
    const page = await getEntityCounterparties(fakeDbCountFails(), {
      kind: 'authority',
      id: 'auth:C',
    });
    expect(page.total).toBeNull(); // must stay "unknown", never fabricated as a real zero
  });

  it('still runs its own COUNT(*) — and can report null — even when the caller passes total: null', async () => {
    const page = await getEntityCounterparties(
      fakeDbCountFails(),
      { kind: 'authority', id: 'auth:C' },
      { total: null },
    );
    expect(page.total).toBeNull();
  });

  it('walks forward then backward through the keyset (before/reverse path)', async () => {
    const p = { kind: 'authority', id: 'auth:C' } as const;
    // page 1 (no cursor) → has a forward cursor
    const page1 = await getEntityCounterparties(fakeDb(), p, { pageSize: 1 });
    expect(page1.rows).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    // page 2 (forward) → has a backward cursor
    const page2 = await getEntityCounterparties(fakeDb(), p, {
      pageSize: 1,
      cursor: page1.nextCursor,
    });
    expect(page2.prevCursor).not.toBeNull();
    // back (a `before` cursor) → exercises ks.reverse + rows.reverse() without throwing
    const back = await getEntityCounterparties(fakeDb(), p, {
      pageSize: 1,
      cursor: page2.prevCursor,
    });
    expect(back.rows).toHaveLength(1);
  });

  it('drops a cursor minted for a different centre (cursor is centre-bound)', async () => {
    // A cursor from centre auth:C must not paginate centre auth:X — the signature mismatch resets it.
    const fromC = await getEntityCounterparties(
      fakeDb(),
      { kind: 'authority', id: 'auth:C' },
      { pageSize: 1 },
    );
    const onX = await getEntityCounterparties(
      fakeDb(),
      { kind: 'authority', id: 'auth:X' },
      { pageSize: 1, cursor: fromC.nextCursor },
    );
    // Decodes to null → treated as page 1 (no Prev), not a mis-anchored page.
    expect(onX.prevCursor).toBeNull();
  });
});
