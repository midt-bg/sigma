import { describe, expect, it } from 'vitest';
import { getEntityNetwork } from './network';

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
          if (sql.includes('FROM flow_pairs WHERE authority_id = ?'))
            return { results: HOP1 as T[] };
          if (sql.includes('WHERE bidder_id IN')) return { results: HOP2 as T[] };
          return { results: [] as T[] };
        },
        async first<T>() {
          if (sql.includes('FROM authority_totals WHERE authority_id')) return CENTER_AUTH as T;
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
});
