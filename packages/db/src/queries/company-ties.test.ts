import { describe, expect, it } from 'vitest';
import { fakeD1 } from '@sigma/test-support';
import { getAuthoritySupplierTies, getCompanyTies } from './company-ties';
import { SURFACED_OWNERSHIP } from './related-persons';

// The tie network is the company↔company graph: who a company is joint-bidding with, who it
// subcontracts to, and which companies share a declared interest with it. The privacy shape matters as
// much as the topology — a person is never a node, and only a company with a PUBLISHED link is offered a
// /conflicts destination — so both are pinned here.

const CENTER = {
  id: 'eik:1',
  name: 'АЛФА СТРОЙ АД',
  kind: 'company',
  won_eur: 124_500_000,
  conflicts: 0,
};

const tie = (over: Record<string, unknown> = {}) => ({
  a_bidder_id: 'eik:1',
  b_bidder_id: 'eik:2',
  kind: 'consortium',
  directed: 0,
  weight_eur: 9_000_000,
  occurrences: 2,
  other_id: 'eik:2',
  other_name: 'БЕТА ИНЖЕНЕРИНГ АД',
  other_kind: 'company',
  other_won_eur: 116_500_000,
  other_conflicts: 0,
  ...over,
});

function db(ties: ReturnType<typeof tie>[], funders: Record<string, unknown>[] = []) {
  return fakeD1([
    { when: 'FROM bidders b LEFT JOIN company_totals', first: CENTER },
    { when: 'WITH tie AS', all: ties },
    { when: 'FROM flow_pairs fp', all: funders },
  ]).db;
}

describe('getCompanyTies', () => {
  it('draws the centre and its tied companies, keeping each tie kind as its own edge', async () => {
    // A pair can be tied in more than one way — joint bidders who also subcontract. The kinds are
    // different claims; collapsing them into one edge would lose the distinction.
    const net = await getCompanyTies(
      db([tie(), tie({ kind: 'subcontract', directed: 1, weight_eur: 2_000_000, occurrences: 3 })]),
      'eik:1',
    );
    expect(net.center?.label).toBe('АЛФА СТРОЙ АД');
    expect(net.nodes.map((n) => n.id)).toEqual(['eik:1', 'eik:2']); // one node, two edges
    expect(net.edges.map((e) => e.kind)).toEqual(['consortium', 'subcontract']);
    expect(net.edges[1]!.directed).toBe(true);
  });

  it('resolves the other endpoint whichever side of the stored pair the centre sits on', async () => {
    // Symmetric ties are stored once with a < b, so a centre is as often the `b` side as the `a` side.
    const net = await getCompanyTies(
      db([
        tie({
          a_bidder_id: 'eik:0',
          b_bidder_id: 'eik:1',
          other_id: 'eik:0',
          other_name: 'ГАМА ООД',
        }),
      ]),
      'eik:1',
    );
    expect(net.nodes.map((n) => n.label)).toEqual(['АЛФА СТРОЙ АД', 'ГАМА ООД']);
  });

  it('offers a /conflicts destination only for a company that has published links', async () => {
    // Sending a reader to /conflicts for a company with no published link lands them on a 404 — and an
    // empty page under a company's name is exactly what that surface refuses to render.
    const net = await getCompanyTies(
      db([
        tie({ other_conflicts: 0 }),
        tie({
          b_bidder_id: 'eik:3',
          other_id: 'eik:3',
          other_name: 'ДЕЛТА ООД',
          other_conflicts: 2,
        }),
      ]),
      'eik:1',
    );
    expect(net.nodes.find((n) => n.id === 'eik:2')?.conflictsHref).toBeNull();
    expect(net.nodes.find((n) => n.id === 'eik:3')?.conflictsHref).toBe('/conflicts/company/3');
  });

  it('never emits a person node, and points a declared-stake edge at the published surface', async () => {
    const net = await getCompanyTies(
      db([tie({ kind: 'declared_stake', weight_eur: 0, occurrences: 1 })]),
      'eik:1',
    );
    expect(net.nodes.every((n) => n.kind === 'company' || n.kind === 'authority')).toBe(true);
    expect(net.edges[0]!.weightEur).toBe(0); // not monetary — the UI must not size it by money
    expect(net.edges[0]!.href).toBe('/conflicts/company/1');
  });

  it('adds the paying institutions as a second layer only when asked', async () => {
    const funders = [
      { authority_id: 'auth:9', authority_name: 'АГЕНЦИЯ ТЕСТ', won_eur: 40_000_000 },
    ];
    const without = await getCompanyTies(db([tie()], funders), 'eik:1');
    expect(without.nodes.some((n) => n.kind === 'authority')).toBe(false);

    const with_ = await getCompanyTies(db([tie()], funders), 'eik:1', { includeFunders: true });
    const auth = with_.nodes.find((n) => n.kind === 'authority')!;
    expect(auth.slug).toBe('9');
    expect(with_.edges.find((e) => e.kind === 'money')).toMatchObject({
      from: 'auth:9',
      to: 'eik:1',
      directed: true,
    });
  });

  it('keeps the strongest ties and reports how many it left out', async () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      tie({
        b_bidder_id: `eik:${i + 2}`,
        other_id: `eik:${i + 2}`,
        other_name: `Ф${i}`,
        occurrences: 1,
        weight_eur: (i + 1) * 1000,
      }),
    );
    const net = await getCompanyTies(db(many), 'eik:1', { maxTies: 2 });
    // Equal recurrence, so money breaks the tie — and the order is the ranking's, not the rows'.
    expect(net.nodes.map((n) => n.id)).toEqual(['eik:1', 'eik:6', 'eik:5']);
    expect(net.omitted).toBe(3);
  });

  it('ranks a recurring pairing above a bigger one-off one', async () => {
    // A pairing that recurs is a relationship; a single large joint contract is an event. Under a
    // money-only ranking a pair with many shared bids sinks below one-off pairings on larger jobs.
    const net = await getCompanyTies(
      db([
        tie({
          b_bidder_id: 'eik:big',
          other_id: 'eik:big',
          other_name: 'ЕДНОКРАТНА',
          occurrences: 1,
          weight_eur: 66_000_000,
        }),
        tie({
          b_bidder_id: 'eik:vdh',
          other_id: 'eik:vdh',
          other_name: 'БЕТА ИНЖЕНЕРИНГ АД',
          occurrences: 7,
          weight_eur: 27_000_000,
        }),
      ]),
      'eik:1',
      { maxTies: 1 },
    );
    expect(net.nodes.map((n) => n.label)).toEqual(['АЛФА СТРОЙ АД', 'БЕТА ИНЖЕНЕРИНГ АД']);
  });

  it('ranks a stake tie by how many officials back it, since it carries no money', async () => {
    const net = await getCompanyTies(
      db([
        tie({
          b_bidder_id: 'eik:2',
          other_id: 'eik:2',
          other_name: 'МАЛКА',
          weight_eur: 1,
          occurrences: 1,
        }),
        tie({
          b_bidder_id: 'eik:3',
          other_id: 'eik:3',
          other_name: 'СТЕЙК',
          kind: 'declared_stake',
          weight_eur: 0,
          occurrences: 4,
        }),
      ]),
      'eik:1',
      { maxTies: 1 },
    );
    // Weighted purely by money the stake tie would rank last at 0 and never be drawn — the one edge on
    // the page that rests on a declared interest would be the first to disappear.
    expect(net.nodes.map((n) => n.label)).toEqual(['АЛФА СТРОЙ АД', 'СТЕЙК']);
  });

  it('returns an empty network for a company that does not exist', async () => {
    const net = await getCompanyTies(
      fakeD1([
        { when: 'FROM bidders b LEFT JOIN', first: null },
        { when: 'WITH tie AS', all: [] },
      ]).db,
      'eik:nope',
    );
    expect(net).toEqual({ center: null, nodes: [], edges: [], omitted: 0 });
  });
});

describe('getAuthoritySupplierTies', () => {
  const AUTH = { name: 'ОБЩИНА ТЕСТОВО', spent_eur: 50_000_000 };
  const supplier = (over: Record<string, unknown> = {}) => ({
    bidder_id: 'eik:1',
    bidder_name: 'АЛФА СТРОЙ АД',
    bidder_kind: 'company',
    won_eur: 9_000_000,
    conflicts: 0,
    ...over,
  });

  function authDb(
    suppliers: ReturnType<typeof supplier>[],
    between: Record<string, unknown>[] = [],
  ) {
    return fakeD1([
      { when: 'FROM authority_totals WHERE authority_id', first: AUTH },
      { when: 'FROM flow_pairs fp WHERE fp.authority_id', all: suppliers },
      { when: 'FROM company_links', all: between },
    ]).db;
  }

  it('draws the authority, its suppliers, and the money that put them there', async () => {
    const net = await getAuthoritySupplierTies(
      authDb([
        supplier(),
        supplier({ bidder_id: 'eik:2', bidder_name: 'БЕТА ООД', won_eur: 4_000 }),
      ]),
      'auth:9',
    );
    expect(net.center).toMatchObject({ kind: 'authority', label: 'ОБЩИНА ТЕСТОВО', slug: '9' });
    expect(net.edges.filter((e) => e.kind === 'money')).toHaveLength(2);
    expect(net.edges.every((e) => e.kind !== 'money' || e.from === 'auth:9')).toBe(true);
  });

  it('adds the ties BETWEEN two of the drawn suppliers — the part a leaderboard cannot show', async () => {
    const net = await getAuthoritySupplierTies(
      authDb(
        [supplier(), supplier({ bidder_id: 'eik:2', bidder_name: 'БЕТА ООД' })],
        [
          {
            a_bidder_id: 'eik:1',
            b_bidder_id: 'eik:2',
            kind: 'consortium',
            directed: 0,
            weight_eur: 3_000_000,
            occurrences: 4,
          },
        ],
      ),
      'auth:9',
    );
    const tie = net.edges.find((e) => e.kind === 'consortium')!;
    expect([tie.from, tie.to]).toEqual(['eik:1', 'eik:2']);
    expect(tie.occurrences).toBe(4);
  });

  it('points a stake tie between two suppliers at the published surface', async () => {
    const net = await getAuthoritySupplierTies(
      authDb(
        [supplier(), supplier({ bidder_id: 'eik:2', bidder_name: 'БЕТА ООД' })],
        [
          {
            a_bidder_id: 'eik:1',
            b_bidder_id: 'eik:2',
            kind: 'declared_stake',
            directed: 0,
            weight_eur: 0,
            occurrences: 1,
          },
        ],
      ),
      'auth:9',
    );
    expect(net.edges.find((e) => e.kind === 'declared_stake')?.href).toBe('/conflicts/company/1');
    // Still no person node anywhere — the tie is between the two companies.
    expect(net.nodes.every((n) => n.kind === 'company' || n.kind === 'authority')).toBe(true);
  });

  it('returns an empty network for an authority with no suppliers, and for an unknown one', async () => {
    expect(await getAuthoritySupplierTies(authDb([]), 'auth:9')).toEqual({
      center: null,
      nodes: [],
      edges: [],
      omitted: 0,
    });
    const unknown = fakeD1([
      { when: 'FROM authority_totals WHERE authority_id', first: null },
      { when: 'FROM flow_pairs fp WHERE fp.authority_id', all: [] },
    ]).db;
    expect((await getAuthoritySupplierTies(unknown, 'auth:nope')).center).toBeNull();
  });
});

describe('the /conflicts destination on a node', () => {
  it('is counted under the gate the page publishes by, evidence seal included — never status alone', async () => {
    const fake = fakeD1([
      { when: 'FROM bidders b LEFT JOIN company_totals', first: CENTER },
      { when: 'WITH tie AS', all: [tie()] },
      { when: 'FROM flow_pairs fp', all: [] },
    ]);
    await getCompanyTies(fake.db, 'eik:1', { includeFunders: true });
    const counted = fake.sql.filter((s) => s.includes('FROM interest_links il'));
    expect(counted).toHaveLength(2); // the centre and its ties
    for (const s of counted) expect(s).toContain(SURFACED_OWNERSHIP);
  });
});
