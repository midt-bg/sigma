/// <reference types="node" />
// The Trade Register layer of the tie graphs at its limits, against a real SQLite built from the production
// migrations: a centre with more people and more reachable companies than the ring holds, a company that both
// owns and is owned, people shared by two suppliers who only a name can order — and an environment without
// the registry tables at all. What the reader relies on: the ring keeps what matters first, counts what it
// leaves out, draws every company once, and never shows an actual owner.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { getAuthoritySupplierTies, getCompanyTies } from './company-ties';

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

let open: DatabaseSync | null = null;

function served(fixture: string, opts: { withoutRegistry?: boolean } = {}): D1Database {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of migrations) {
    if (opts.withoutRegistry && f.includes('registry')) continue;
    sqlite.exec(readFileSync(resolve(migrationsDir, f), 'utf8'));
  }
  sqlite.exec(fixture);
  open = sqlite;
  return d1FromSqlite(sqlite);
}

afterEach(() => {
  open?.close();
  open = null;
});

const indent = (c: string) => c.repeat(64);
const node = (i: string) => `rp:${i}`;

/** Bidders by ЕИК, with a rollup row only for those given a won amount. */
function bidders(rows: [eik: string, name: string, won: number | null][]): string {
  return rows
    .map(
      ([eik, name, won]) =>
        `INSERT INTO bidders (id, name, kind) VALUES ('eik:${eik}', '${name}', 'company');` +
        (won === null
          ? ''
          : `INSERT INTO company_totals (bidder_id, name, kind, won_eur, contracts, authorities)
             VALUES ('eik:${eik}', '${name}', 'company', ${won}, 1, 1);`),
    )
    .join('\n');
}

const FIELD: Record<string, string> = {
  manager: '00070',
  partner: '00190',
  sole_owner: '00230',
  beneficial_owner: '05500',
};

/** Registered roles: [company, role, holder, holder name, entry, removed on]. */
function roles(
  kind: 'person' | 'entity',
  rows: [
    eik: string,
    role: string,
    holder: string,
    name: string,
    entry?: string,
    removed?: string,
  ][],
): string {
  const values = rows.map(
    ([eik, role, holder, name, entry = 'e1', removed]) =>
      `('${eik}', '0000', '${FIELD[role]}', '${role}', '${kind}', '${holder}', '${name}', '${entry}',
        '2015-01-01', ${removed ? `'${removed}'` : 'NULL'})`,
  );
  return `INSERT INTO registry_roles (eik, sub_uic, field_ident, role, subject_kind, subject_id, subject_name,
    entry_number, added_on, removed_on) VALUES ${values.join(',\n')};`;
}

// ЦЕНТЪР: two managers who hold no other role, seven partners who each hold one elsewhere — Васил at three
// companies (one is his old partnership, entered again), Георги at two, one of them the centre's joint bidder —
// and an actual owner.
const CENTRE = '100000001';
const [ANGEL, BOYAN, OWNER] = [indent('a'), indent('b'), indent('c')];
const PARTNERS = [
  'ВАСИЛ ВАСИЛЕВ',
  'ГЕОРГИ ГЕОРГИЕВ',
  'ДИМИТЪР ДИМИТРОВ',
  'ЕЛЕНА ЕЛЕНОВА',
  'ЖИВКО ЖИВКОВ',
  'ЗОРНИЦА ЗОРОВА',
  'ИВАН ИВАНОВ',
].map((name, i) => ({ id: indent(String(i + 1)), name }));
const [VASIL, GEORGI, IVAN] = [PARTNERS[0]!, PARTNERS[1]!, PARTNERS[6]!];

const CROWDED = [
  bidders([
    [CENTRE, 'ЦЕНТЪР ООД', 1000],
    ['200000000', 'СЪИЗПЪЛНИТЕЛ ООД', 900],
    ['200000001', 'ФИРМА 1 ООД', 500],
    ...[2, 3, 4, 5, 6, 7, 8, 9].map((n): [string, string, null] => [
      `20000000${n}`,
      `ФИРМА ${n} ООД`,
      null,
    ]),
  ]),
  `INSERT INTO company_links (a_bidder_id, b_bidder_id, kind, directed, weight_eur, occurrences)
   VALUES ('eik:${CENTRE}', 'eik:200000000', 'consortium', 0, 800, 2);`,
  roles('person', [
    [CENTRE, 'manager', ANGEL, 'АНГЕЛ АНГЕЛОВ'],
    [CENTRE, 'manager', BOYAN, 'БОЯН БОЕВ'],
    [CENTRE, 'partner', VASIL.id, VASIL.name, 'e0', '2016-01-01'],
    ...PARTNERS.map((p): [string, string, string, string] => [CENTRE, 'partner', p.id, p.name]),
    [CENTRE, 'beneficial_owner', OWNER, 'СКРИТ СОБСТВЕНИК'],
    ['200000001', 'manager', VASIL.id, VASIL.name],
    ['200000007', 'manager', VASIL.id, VASIL.name],
    ['200000008', 'manager', VASIL.id, VASIL.name],
    ['200000000', 'manager', GEORGI.id, GEORGI.name],
    ['200000002', 'manager', GEORGI.id, GEORGI.name],
    ...PARTNERS.slice(2, 6).map((p, i): [string, string, string, string] => [
      `20000000${i + 3}`,
      'manager',
      p.id,
      p.name,
    ]),
    ['200000009', 'manager', IVAN.id, IVAN.name],
  ]),
].join('\n');

describe('a centre with more people and companies than the ring holds', () => {
  it('draws the best-connected people and the companies they reach, and counts the rest', async () => {
    const net = await getCompanyTies(served(CROWDED), `eik:${CENTRE}`);
    // Six people at most, those who reach other companies first — Васил (three), Георги (two), then the
    // standing order; Иван, the seventh with a role elsewhere, and both managers are left out. Six reached
    // companies at most, the joint bidder already on the ring not counted: ФИРМА 7 and 8 are left out.
    expect(net.nodes.map((n) => [n.id, n.hop])).toEqual([
      [`eik:${CENTRE}`, 0],
      ['eik:200000000', 1],
      ...PARTNERS.slice(0, 6).map((p) => [node(p.id), 1]),
      ...[1, 2, 3, 4, 5, 6].map((n) => [`eik:20000000${n}`, 2]),
    ]);
    expect(net.omitted).toBe(5);
    const json = JSON.stringify(net);
    for (const left of ['eik:200000007', 'eik:200000008', 'eik:200000009', ANGEL, BOYAN, IVAN.id])
      expect(json).not.toContain(left);
    expect(json).not.toContain(OWNER);
    expect(json).not.toContain('СКРИТ СОБСТВЕНИК');
  });

  it('ties a person to a company already on the ring without drawing it twice, and a role once', async () => {
    const net = await getCompanyTies(served(CROWDED), `eik:${CENTRE}`);
    const edge = (from: string, to: string) =>
      net.edges.find((e) => e.from === from && e.to === to);
    expect(net.nodes.filter((n) => n.id === 'eik:200000000')).toHaveLength(1);
    expect(edge(node(GEORGI.id), 'eik:200000000')).toMatchObject({
      kind: 'role',
      roles: ['manager'],
      current: true,
    });
    // Васил's partnership ended and was entered again: one role, standing.
    expect(edge(node(VASIL.id), `eik:${CENTRE}`)).toMatchObject({
      roles: ['partner'],
      current: true,
      directed: false,
    });
    expect(net.edges.filter((e) => e.kind === 'role')).toHaveLength(13);
    // A reached company without a rollup row is drawn at zero, not left without a size.
    expect(net.nodes.find((n) => n.id === 'eik:200000001')?.valueEur).toBe(500);
    expect(net.nodes.find((n) => n.id === 'eik:200000002')?.valueEur).toBe(0);
  });
});

// ХОЛДИНГ: СЪДРУЖНИК is its partner (entered twice) and it is СЪДРУЖНИК's partner in turn; it owns three more
// companies now and two it has left, the larger of those the largest of all. It has no people of its own.
const HOLDER = '300000001';
const HOLDINGS = [
  bidders([
    [HOLDER, 'ХОЛДИНГ ЦЕНТЪР АД', 2000],
    ['300000002', 'СЪДРУЖНИК ООД', 50],
    ['300000003', 'ДЪЩЕРНО ЕООД', 50],
    ['300000004', 'ВТОРО ДЪЩЕРНО ООД', null],
    ['300000005', 'ТРЕТО ДЪЩЕРНО ООД', null],
    ['300000006', 'БИВШО ГОЛЯМО ООД', 10000],
    ['300000007', 'БИВШО МАЛКО ООД', null],
  ]),
  roles('entity', [
    [HOLDER, 'partner', '300000002', 'СЪДРУЖНИК ООД', 'h0', '2016-01-01'],
    [HOLDER, 'partner', '300000002', 'СЪДРУЖНИК ООД', 'h1'],
    ['300000002', 'partner', HOLDER, 'ХОЛДИНГ ЦЕНТЪР АД'],
    ['300000003', 'sole_owner', HOLDER, 'ХОЛДИНГ ЦЕНТЪР АД'],
    ['300000004', 'partner', HOLDER, 'ХОЛДИНГ ЦЕНТЪР АД'],
    ['300000005', 'partner', HOLDER, 'ХОЛДИНГ ЦЕНТЪР АД'],
    ['300000006', 'partner', HOLDER, 'ХОЛДИНГ ЦЕНТЪР АД', 'e1', '2016-01-01'],
    ['300000007', 'partner', HOLDER, 'ХОЛДИНГ ЦЕНТЪР АД', 'e1', '2016-01-01'],
  ]),
].join('\n');

describe('a company that owns and is owned', () => {
  it('keeps the standing holdings before a larger ended one, and draws a cross-holding once each way', async () => {
    const net = await getCompanyTies(served(HOLDINGS), `eik:${HOLDER}`);
    expect(net.nodes.map((n) => [n.id, n.hop])).toEqual([
      [`eik:${HOLDER}`, 0],
      ['eik:300000002', 1],
      ['eik:300000003', 1],
      ['eik:300000004', 1],
      ['eik:300000005', 1],
    ]);
    expect(net.omitted).toBe(2); // the two ended holdings, БИВШО ГОЛЯМО among them
    expect(net.edges.map((e) => [e.from, e.to, e.roles, e.current])).toEqual([
      [`eik:${HOLDER}`, 'eik:300000002', ['partner'], true],
      [`eik:${HOLDER}`, 'eik:300000003', ['sole_owner'], true],
      ['eik:300000002', `eik:${HOLDER}`, ['partner'], true],
      [`eik:${HOLDER}`, 'eik:300000004', ['partner'], true],
      [`eik:${HOLDER}`, 'eik:300000005', ['partner'], true],
    ]);
    expect(net.edges.every((e) => e.kind === 'role' && e.directed && e.weightEur === 0)).toBe(true);
  });
});

// Two suppliers of one institution, tied by a subcontract; three people hold a role at both.
const AUTH = 'auth:400000000';
const [PETAR, KRASIMIR, ANA] = [indent('d'), indent('e'), indent('f')];
const SUPPLIERS = [
  `INSERT INTO authorities (id, name) VALUES ('${AUTH}', 'ОБЩИНА ДОСТАВКИ');
   INSERT INTO authority_totals (authority_id, name, spent_eur, contracts, suppliers, avg_eur)
   VALUES ('${AUTH}', 'ОБЩИНА ДОСТАВКИ', 500, 2, 2, 250);`,
  bidders([
    ['400000001', 'ДОСТАВЧИК 1 ООД', 300],
    ['400000002', 'ДОСТАВЧИК 2 ООД', 200],
  ]),
  `INSERT INTO flow_pairs (authority_id, bidder_id, authority_name, bidder_name, bidder_kind, won_eur, contracts)
   VALUES ('${AUTH}', 'eik:400000001', 'ОБЩИНА ДОСТАВКИ', 'ДОСТАВЧИК 1 ООД', 'company', 300, 1),
          ('${AUTH}', 'eik:400000002', 'ОБЩИНА ДОСТАВКИ', 'ДОСТАВЧИК 2 ООД', 'company', 200, 1);
   INSERT INTO company_links (a_bidder_id, b_bidder_id, kind, directed, weight_eur, occurrences)
   VALUES ('eik:400000001', 'eik:400000002', 'subcontract', 1, 50, 1);`,
].join('\n');
const SHARED = roles('person', [
  ['400000001', 'manager', PETAR, 'ПЕТЪР ПЕТРОВ'],
  ['400000002', 'manager', PETAR, 'ПЕТЪР ПЕТРОВ'],
  ['400000001', 'manager', KRASIMIR, 'КРАСИМИР КРАСИМИРОВ'],
  ['400000002', 'partner', KRASIMIR, 'КРАСИМИР КРАСИМИРОВ'],
  ['400000001', 'manager', ANA, 'АНА АНОВА', 'e1', '2016-01-01'],
  ['400000002', 'manager', ANA, 'АНА АНОВА', 'e1', '2016-01-01'],
]);

describe('people shared by two suppliers', () => {
  it('orders the standing ones by name, ahead of one whose roles ended', async () => {
    const net = await getAuthoritySupplierTies(served(`${SUPPLIERS}\n${SHARED}`), AUTH);
    expect(net.nodes.filter((n) => n.kind === 'person').map((n) => [n.label, n.hop])).toEqual([
      ['КРАСИМИР КРАСИМИРОВ', 2],
      ['ПЕТЪР ПЕТРОВ', 2],
      ['АНА АНОВА', 2],
    ]);
    const held = (who: string) =>
      net.edges
        .filter((e) => e.from === node(who))
        .map((e) => [e.to, e.roles, e.current])
        .sort();
    expect(held(KRASIMIR)).toEqual([
      ['eik:400000001', ['manager'], true],
      ['eik:400000002', ['partner'], true],
    ]);
    expect(held(ANA).every(([, , current]) => current === false)).toBe(true);
    expect(net.omitted).toBe(0);
  });
});

describe('an environment without the registry tables', () => {
  it('still draws both graphs from the corpus — money and company ties — without the layer', async () => {
    const db = served(SUPPLIERS, { withoutRegistry: true });
    const suppliers = await getAuthoritySupplierTies(db, AUTH);
    expect(suppliers.nodes.map((n) => n.id)).toEqual([AUTH, 'eik:400000001', 'eik:400000002']);
    expect(suppliers.edges.map((e) => [e.kind, e.from, e.to])).toEqual([
      ['money', AUTH, 'eik:400000001'],
      ['money', AUTH, 'eik:400000002'],
      ['subcontract', 'eik:400000001', 'eik:400000002'],
    ]);
    expect(suppliers.omitted).toBe(0);

    const company = await getCompanyTies(db, 'eik:400000001', { includeFunders: true });
    expect(company.nodes.map((n) => n.id)).toEqual(['eik:400000001', 'eik:400000002', AUTH]);
    expect(company.edges.map((e) => [e.kind, e.from, e.to])).toEqual([
      ['subcontract', 'eik:400000001', 'eik:400000002'],
      ['money', AUTH, 'eik:400000001'],
    ]);
    expect(company.omitted).toBe(0);
  });
});

describe('a company known only from its partida', () => {
  it('is the centre of its registered people, named with its legal form', async () => {
    const db = served(
      [
        `INSERT INTO registry_deeds (eik, name, legal_form, seat_settlement, outcome, fetched_at)
         VALUES ('300000003', 'САМО РЕГИСТЪР', 'EOOD', 'гр. Русе', 'ok', '2026-09-01T00:00:00Z'),
                ('300000004', NULL, NULL, NULL, 'absent', '2026-09-01T00:00:00Z');`,
        bidders([['200000001', 'ФИРМА 1 ООД', 500]]),
        roles('person', [
          ['300000003', 'manager', ANGEL, 'АНГЕЛ АНГЕЛОВ'],
          ['200000001', 'partner', ANGEL, 'АНГЕЛ АНГЕЛОВ'],
        ]),
      ].join('\n'),
    );
    const net = await getCompanyTies(db, 'eik:300000003');
    expect(net.center).toMatchObject({ id: 'eik:300000003', label: 'САМО РЕГИСТЪР ЕООД' });
    expect(net.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([node(ANGEL), 'eik:200000001']),
    );
    expect((await getCompanyTies(db, 'eik:300000004')).center).toBeNull();
    expect((await getCompanyTies(db, 'eik:300000005')).center).toBeNull();
  });
});
