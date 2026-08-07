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
    // Assert the full mapped shape for BOTH sides — label (cleanName/entityName) and value (slug),
    // not just the authority value, so the companies-branch mapping is actually exercised.
    expect(centerOptions.authorities[0]).toEqual({
      kind: 'authority',
      label: 'Център Институция',
      value: 'a:C',
    });
    expect(centerOptions.companies[0]).toEqual({ kind: 'company', label: 'Фирма А', value: 'c:A' });
  });
});

// Flexible fake D1 for the paths the shared fakeDb() above does not exercise.
function netDb(opts: {
  topAuthority?: { authority_id: string } | null;
  centerAuth?: { name: string; spent_eur: number } | null;
  centerComp?: { name: string; kind: 'company' | 'consortium'; won_eur: number } | null;
  hop1?: unknown[];
  hop2?: unknown[];
  pickerAuth?: unknown[];
  pickerComp?: unknown[];
}): D1Database {
  return {
    prepare(sql: string) {
      const api = {
        bind() {
          return api;
        },
        async all<T>() {
          if (sql.includes('EXISTS') && sql.includes('FROM authority_totals'))
            return { results: (opts.pickerAuth ?? []) as T[] };
          if (sql.includes('EXISTS') && sql.includes('FROM company_totals'))
            return { results: (opts.pickerComp ?? []) as T[] };
          if (
            sql.includes('flow_pairs WHERE authority_id = ?') ||
            sql.includes('flow_pairs WHERE bidder_id = ?')
          )
            return { results: (opts.hop1 ?? []) as T[] };
          if (sql.includes(' IN (')) return { results: (opts.hop2 ?? []) as T[] };
          return { results: [] as T[] };
        },
        async first<T>() {
          if (sql.includes('LIMIT 1')) return (opts.topAuthority ?? null) as T;
          if (sql.includes('SELECT name, spent_eur')) return (opts.centerAuth ?? null) as T;
          if (sql.includes('SELECT name, kind, won_eur')) return (opts.centerComp ?? null) as T;
          return null as T;
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

const COMP_HOP1 = [
  {
    authority_id: 'auth:A',
    bidder_id: 'eik:C',
    authority_name: 'Инст А',
    bidder_name: 'Център ООД',
    bidder_kind: 'company',
    won_eur: 5000,
    contracts: 5,
  },
];
const COMP_HOP2 = [
  {
    authority_id: 'auth:A',
    bidder_id: 'eik:D',
    authority_name: 'Инст А',
    bidder_name: 'Друга ООД',
    bidder_kind: 'company',
    won_eur: 2000,
    contracts: 2,
  },
];

describe('getEntityNetwork — company centre, defaults, and fallbacks', () => {
  it('builds a company-centred network (company -> authority hop1 -> company hop2)', async () => {
    const db = netDb({
      centerComp: { name: 'Център ООД', kind: 'company', won_eur: 9000 },
      hop1: COMP_HOP1,
      hop2: COMP_HOP2,
    });
    const { center, nodes } = await getEntityNetwork(db, { kind: 'company', id: 'eik:C' });
    expect(center).toMatchObject({ id: 'eik:C', kind: 'company', label: 'Център ООД' });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get('auth:A')).toMatchObject({ kind: 'authority', hop: 1 });
    expect(byId.get('eik:D')).toMatchObject({ kind: 'company', hop: 2 });
  });

  it('defaults to the top authority by spend when no centre is given', async () => {
    const db = netDb({
      topAuthority: { authority_id: 'auth:C' },
      centerAuth: { name: 'Център Институция', spent_eur: 100000 },
      hop1: HOP1,
      hop2: HOP2,
      pickerAuth: PICKER_AUTH,
    });
    const { center } = await getEntityNetwork(db, null);
    expect(center).toMatchObject({ id: 'auth:C', kind: 'authority' });
  });

  it('returns an empty network when no authority has any pairs', async () => {
    const { center, nodes, edges } = await getEntityNetwork(netDb({ topAuthority: null }), null);
    expect(center).toBeNull();
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it('skips the centre picker when includeCenterOptions is false', async () => {
    const db = netDb({ centerAuth: { name: 'Ц', spent_eur: 1 }, hop1: HOP1, hop2: HOP2 });
    const { centerOptions } = await getEntityNetwork(
      db,
      { kind: 'authority', id: 'auth:C' },
      { includeCenterOptions: false },
    );
    expect(centerOptions).toEqual({ authorities: [], companies: [] });
  });

  it('falls back to a hop-1 sample name when the centre rollup row is missing', async () => {
    const db = netDb({ centerAuth: null, hop1: HOP1, hop2: [] });
    const { center } = await getEntityNetwork(db, { kind: 'authority', id: 'auth:C' });
    expect(center).toMatchObject({ label: 'Център Институция', valueEur: 0 }); // name from HOP1[0]
  });

  it('returns an empty network when the centre cannot be resolved at all', async () => {
    const { center, nodes } = await getEntityNetwork(netDb({ centerAuth: null, hop1: [] }), {
      kind: 'authority',
      id: 'auth:missing',
    });
    expect(center).toBeNull();
    expect(nodes).toEqual([]);
  });
});

describe('getEntityNetwork — hop-2 reduction and node weighting', () => {
  it('keeps one hop-2 counterparty per neighbour and drops one that is the centre', async () => {
    const hop2 = [
      {
        authority_id: 'auth:X',
        bidder_id: 'eik:A',
        authority_name: 'X',
        bidder_name: 'Фирма А',
        bidder_kind: 'company',
        won_eur: 2000,
        contracts: 2,
      },
      {
        authority_id: 'auth:Y',
        bidder_id: 'eik:A',
        authority_name: 'Y',
        bidder_name: 'Фирма А',
        bidder_kind: 'company',
        won_eur: 1000,
        contracts: 1,
      }, // same neighbour → skipped
      {
        authority_id: 'auth:C',
        bidder_id: 'eik:B',
        authority_name: 'C',
        bidder_name: 'Фирма Б',
        bidder_kind: 'company',
        won_eur: 500,
        contracts: 1,
      }, // counterparty is the centre → skipped
    ];
    const db = netDb({ centerAuth: { name: 'Център', spent_eur: 42 }, hop1: HOP1, hop2 });
    const { nodes } = await getEntityNetwork(db, { kind: 'authority', id: 'auth:C' });
    expect(nodes.map((n) => n.id).sort()).toEqual(['auth:C', 'auth:X', 'eik:A', 'eik:B']);
  });

  it('weights an edgeless centre from its own rollup value', async () => {
    const db = netDb({ centerAuth: { name: 'Център', spent_eur: 777 }, hop1: [], hop2: [] });
    const { nodes } = await getEntityNetwork(db, { kind: 'authority', id: 'auth:C' });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ id: 'auth:C', valueEur: 777 }); // weight.get undefined → nd.valueEur
  });
});

describe('getEntityNetwork — company centre sample fallback', () => {
  it('labels a company centre from a hop-1 sample when the rollup row is missing', async () => {
    const db = netDb({ centerComp: null, hop1: COMP_HOP1, hop2: [] });
    const { center } = await getEntityNetwork(db, { kind: 'company', id: 'eik:C' });
    expect(center).toMatchObject({ id: 'eik:C', label: 'Център ООД', valueEur: 0 });
  });

  it('returns an empty network when a company centre resolves to no name at all', async () => {
    // company_totals row missing AND no hop-1 sample → name is null → loadCenter returns null.
    const db = netDb({ centerComp: null, hop1: [] });
    const { center, nodes } = await getEntityNetwork(db, { kind: 'company', id: 'eik:gone' });
    expect(center).toBeNull();
    expect(nodes).toEqual([]);
  });

  it('defaults a company centre kind to „company" when neither the rollup nor the sample carries one', async () => {
    // Sample supplies the name but no bidder_kind → row?.kind ?? sample?.bidder_kind ?? 'company'.
    const sample = [
      {
        authority_id: 'auth:A',
        bidder_id: 'eik:C',
        authority_name: 'Инст',
        bidder_name: 'Безвидна ООД',
        bidder_kind: null,
        won_eur: 100,
        contracts: 1,
      },
    ];
    const db = netDb({ centerComp: null, hop1: sample, hop2: [] });
    const { center } = await getEntityNetwork(db, { kind: 'company', id: 'eik:C' });
    expect(center).toMatchObject({ id: 'eik:C', kind: 'company' });
  });
});

describe('getEntityNetwork — includeCenterOptions and neighbour dedup', () => {
  it('skips the picker on the empty-default path when includeCenterOptions is false', async () => {
    const { center, centerOptions } = await getEntityNetwork(netDb({ topAuthority: null }), null, {
      includeCenterOptions: false,
    });
    expect(center).toBeNull();
    expect(centerOptions).toEqual({ authorities: [], companies: [] }); // emptyCenterOptions, no query
  });

  it('does not duplicate a hop-1 neighbour that appears twice in flow_pairs', async () => {
    // Two flow rows to the same bidder → one node, but an edge each (the `!nodes.has` guard skips the
    // second set() while still recording the edge).
    const dupHop1 = [
      HOP1[0]!,
      { ...HOP1[0]!, won_eur: 1000, contracts: 1 }, // same bidder_id 'eik:A'
    ];
    const db = netDb({ centerAuth: { name: 'Ц', spent_eur: 1 }, hop1: dupHop1, hop2: [] });
    const { nodes, edges } = await getEntityNetwork(db, { kind: 'authority', id: 'auth:C' });
    expect(nodes.filter((n) => n.id === 'eik:A')).toHaveLength(1); // deduped node
    expect(edges.filter((e) => e.to === 'eik:A')).toHaveLength(2); // one edge per row
  });
});
