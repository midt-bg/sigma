/// <reference types="node" />
// The Trade Register layer as the site reads it, against a real SQLite built from the production migrations.
// What the reader relies on: only the roles the site shows leave it — never the actual owners — a role reads as
// standing or ended with its dates, a person has a page only for a role the site shows, and the graph reaches
// from a company to its people and on to their other companies.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { RegistryRoleKind } from '@sigma/api-contract';
import { d1FromSqlite } from '@sigma/test-support';
import { getAuthoritySupplierTies, getCompanyTies } from './company-ties';
import { getRegistrySourceCompanies } from './person-identity';
import { registryPersonIdFromSlug, registryPersonSlug } from './identity';
import {
  PUBLIC_ROLES,
  getCompanyPeople,
  getRegistryPerson,
  partidaEik,
  registryRead,
} from './registry';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../migrations');
const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const hash = (c: string) => c.repeat(64).slice(0, 64);
const ANNA = hash('a');
const BORIS = hash('b');
const VERA = hash('c');
const OWNER = hash('d');

const FIXTURE = `
INSERT INTO authorities (id, name, bulstat) VALUES ('auth:100000001', 'ОБЩИНА ТЕСТ', '100000001');
INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
  ('eik:111111111', 'АЛФА ООД', '111111111', '111111111', 1, 'company'),
  ('eik:222222222', 'БЕТА АД', '222222222', '222222222', 1, 'company'),
  ('eik:333333333', 'ГАМА ЕООД', '333333333', '333333333', 1, 'company'),
  ('eik:444444444', 'ХОЛДИНГ АД', '444444444', '444444444', 1, 'company');
INSERT INTO company_totals (bidder_id, name, kind, won_eur, contracts, authorities) VALUES
  ('eik:111111111', 'АЛФА ООД', 'company', 1000, 2, 1),
  ('eik:222222222', 'БЕТА АД', 'company', 5000, 3, 1),
  ('eik:333333333', 'ГАМА ЕООД', 'company', 700, 1, 1),
  ('eik:444444444', 'ХОЛДИНГ АД', 'company', 90, 1, 1);
INSERT INTO authority_totals (authority_id, name, spent_eur, contracts, suppliers, avg_eur) VALUES
  ('auth:100000001', 'ОБЩИНА ТЕСТ', 6700, 6, 3, 1116);
INSERT INTO flow_pairs (authority_id, bidder_id, authority_name, bidder_name, bidder_kind, won_eur, contracts) VALUES
  ('auth:100000001', 'eik:111111111', 'ОБЩИНА ТЕСТ', 'АЛФА ООД', 'company', 1000, 2),
  ('auth:100000001', 'eik:222222222', 'ОБЩИНА ТЕСТ', 'БЕТА АД', 'company', 5000, 3),
  ('auth:100000001', 'eik:333333333', 'ОБЩИНА ТЕСТ', 'ГАМА ЕООД', 'company', 700, 1);
INSERT INTO registry_deeds (eik, name, legal_form, status, outcome, fetched_at) VALUES
  ('111111111', 'АЛФА ООД', 'OOD', 'N', 'ok', '2026-09-10T03:00:00Z'),
  ('222222222', 'БЕТА АД', 'AD', 'N', 'ok', '2026-09-09T03:00:00Z'),
  ('333333333', 'ГАМА ЕООД', 'EOOD', 'N', 'ok', '2026-09-08T03:00:00Z'),
  ('555555555', NULL, NULL, NULL, 'absent', '2026-09-08T03:00:00Z');
INSERT INTO registry_persons (indent, name, indent_type) VALUES
  ('${ANNA}', 'АННА ПЕТРОВА', 'EGN'),
  ('${BORIS}', 'БОРИС ИВАНОВ', 'EGN'),
  ('${VERA}', 'ВЕРА ГЕОРГИЕВА', 'EGN'),
  ('${OWNER}', 'САМО СОБСТВЕНИК', 'EGN');
INSERT INTO registry_roles (eik, sub_uic, field_ident, role, subject_kind, subject_id, subject_name, share,
                            country, entry_number, added_on, removed_on) VALUES
  -- АЛФА: Анна manages it and owns half; Борис managed it before her; a holding company owns the other half;
  -- a foreigner the register does not identify is a partner; an actual owner is recorded.
  ('111111111', '0000', '00070', 'manager', 'person', '${ANNA}', 'АННА ПЕТРОВА', NULL, NULL, 'e1', '2019-03-12', NULL),
  ('111111111', '0000', '00190', 'partner', 'person', '${ANNA}', 'АННА ПЕТРОВА', '500 BGN', 'БЪЛГАРИЯ', 'e1', '2019-03-12', NULL),
  ('111111111', '0000', '00070', 'manager', 'person', '${BORIS}', 'БОРИС ИВАНОВ', NULL, NULL, 'e0', '2015-01-01', '2019-03-12'),
  ('111111111', '0000', '00190', 'partner', 'entity', '444444444', 'ХОЛДИНГ АД', '500 BGN', 'БЪЛГАРИЯ', 'e1', '2019-03-12', NULL),
  ('111111111', '0000', '00190', 'partner', 'person', 'local:111111111:JOHN SMITH', 'JOHN SMITH', NULL, 'ВЕЛИКОБРИТАНИЯ', 'e2', '2020-01-01', NULL),
  ('111111111', '0000', '05500', 'beneficial_owner', 'person', '${OWNER}', 'САМО СОБСТВЕНИК', '100', 'БЪЛГАРИЯ', 'e3', '2021-01-01', NULL),
  -- БЕТА: Анна on the board, Вера its representative; the same actual owner.
  ('222222222', '0000', '00120', 'board_of_directors', 'person', '${ANNA}', 'АННА ПЕТРОВА', NULL, NULL, 'b1', '2020-05-05', NULL),
  ('222222222', '0000', '00100', 'representative', 'person', '${VERA}', 'ВЕРА ГЕОРГИЕВА', NULL, NULL, 'b1', '2020-05-05', NULL),
  ('222222222', '0000', '05500', 'beneficial_owner', 'person', '${OWNER}', 'САМО СОБСТВЕНИК', '100', 'БЪЛГАРИЯ', 'b2', '2021-01-01', NULL),
  -- ГАМА: Борис managed it too, once; БЕТА is its sole owner.
  ('333333333', '0000', '00070', 'manager', 'person', '${BORIS}', 'БОРИС ИВАНОВ', NULL, NULL, 'g1', '2016-01-01', '2018-01-01'),
  ('333333333', '0000', '00230', 'sole_owner', 'entity', '222222222', 'БЕТА АД', NULL, 'БЪЛГАРИЯ', 'g2', '2017-01-01', NULL);
`;

let open: DatabaseSync | null = null;

function served(opts: { withoutRegistry?: boolean } = {}): D1Database {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of migrationFiles) {
    if (opts.withoutRegistry && f.includes('registry')) continue;
    sqlite.exec(readFileSync(resolve(migrationsDir, f), 'utf8'));
  }
  if (!opts.withoutRegistry) sqlite.exec(FIXTURE);
  open = sqlite;
  return d1FromSqlite(sqlite);
}

afterEach(() => {
  open?.close();
  open = null;
});

describe('the roles the site shows', () => {
  it('are every role the register records but the actual owner', () => {
    // Exhaustive by type: a role added to the contract fails to compile here until it is placed.
    const every: Record<RegistryRoleKind, true> = {
      manager: true,
      representative: true,
      chair: true,
      board_of_directors: true,
      management_board: true,
      governing_body: true,
      board_of_trustees: true,
      supervisory_board: true,
      controlling_board: true,
      verification_commission: true,
      partner: true,
      sole_owner: true,
      trader: true,
      procurator: true,
      branch_manager: true,
      liquidator: true,
      trustee: true,
      beneficial_owner: true,
    };
    expect([...PUBLIC_ROLES].sort()).toEqual(
      Object.keys(every)
        .filter((r) => r !== 'beneficial_owner')
        .sort(),
    );
  });
});

describe('getCompanyPeople', () => {
  it('lists the management and ownership, standing roles first, the ended after — never the actual owner', async () => {
    const people = await getCompanyPeople(served(), 'eik:111111111');
    expect(people.asOf).toBe('2026-09-10');
    expect(people.roles.map((r) => [r.holder.name, r.role, r.addedOn, r.removedOn])).toEqual([
      ['АННА ПЕТРОВА', 'manager', '2019-03-12', null],
      ['АННА ПЕТРОВА', 'partner', '2019-03-12', null],
      ['ХОЛДИНГ АД', 'partner', '2019-03-12', null],
      ['JOHN SMITH', 'partner', '2020-01-01', null],
      ['БОРИС ИВАНОВ', 'manager', '2015-01-01', '2019-03-12'],
    ]);
    expect(JSON.stringify(people)).not.toContain('САМО СОБСТВЕНИК');
  });

  it('links a person the register identifies and a company that won here — and no one else; a person has no country', async () => {
    const { roles } = await getCompanyPeople(served(), 'eik:111111111');
    const by = (name: string) => roles.find((r) => r.holder.name === name)!.holder;
    expect(by('АННА ПЕТРОВА')).toEqual({
      kind: 'person',
      name: 'АННА ПЕТРОВА',
      href: `/persons/${ANNA}`,
      eik: null,
      country: null,
    });
    expect(by('ХОЛДИНГ АД')).toMatchObject({
      kind: 'entity',
      href: '/companies/444444444',
      eik: '444444444',
    });
    expect(by('JOHN SMITH')).toMatchObject({ kind: 'person', href: null, country: null });
    expect(roles.find((r) => r.holder.name === 'АННА ПЕТРОВА' && r.role === 'partner')!.share).toBe(
      '500 BGN',
    );
  });

  it('is empty for a company whose partida is not read yet, one the register does not have, and one with no ЕИК', async () => {
    const db = served();
    for (const id of ['eik:444444444', 'eik:555555555', 'name:ФИРМА', 'eik:1111111110001'])
      expect(await getCompanyPeople(db, id)).toEqual({ roles: [], asOf: null });
  });
});

describe('getRegistryPerson', () => {
  it('shows only procurement recipients with profiles, including organisations with zero recorded value', async () => {
    const db = served();
    open!.exec(`
      INSERT INTO bidders (id,name,kind) VALUES
        ('eik:955555555','БЕЗ ПРОФИЛ','company'),
        ('eik:966666666','БЕЗ ПОРЪЧКИ','company'),
        ('eik:988888888','СДРУЖЕНИЕ','company');
      INSERT INTO company_totals (bidder_id,name,kind,won_eur,contracts,authorities) VALUES
        ('eik:966666666','БЕЗ ПОРЪЧКИ','company',0,0,0),
        ('eik:988888888','СДРУЖЕНИЕ','company',0,1,1);
      INSERT INTO registry_deeds (eik,name,outcome,fetched_at) VALUES
        ('955555555','БЕЗ ПРОФИЛ','ok','2026-09-10'),
        ('966666666','БЕЗ ПОРЪЧКИ','ok','2026-09-10'),
        ('977777777','САМО В ТР','ok','2026-09-10'),
        ('988888888','СДРУЖЕНИЕ','ok','2026-09-10');
      INSERT INTO registry_roles (eik,sub_uic,field_ident,role,subject_kind,subject_id,subject_name,entry_number,added_on)
        SELECT eik,'0000','00070','manager','person','${ANNA}','АННА ПЕТРОВА','new','2020-01-01'
        FROM registry_deeds WHERE eik IN ('955555555','966666666','977777777','988888888');
    `);
    const p = (await getRegistryPerson(db, ANNA))!;
    expect(new Set(p.roles.map((r) => r.company.eik))).toEqual(
      new Set(['111111111', '222222222', '988888888']),
    );
    expect(p.roles.every((r) => r.company.href)).toBe(true);
    expect(
      p.network.nodes
        .filter((n) => n.hop === 1)
        .map((n) => n.id)
        .sort(),
    ).toEqual(['eik:111111111', 'eik:222222222', 'eik:988888888']);
    expect(p).toMatchObject({ companies: 3, wonEur: 6000 });
    open!.exec("UPDATE company_totals SET contracts=0 WHERE bidder_id='eik:222222222'");
    expect(await getRegistryPerson(db, VERA)).toBeNull();
  });

  it('gathers a person’s roles across companies, with the companies around them in a graph', async () => {
    const p = (await getRegistryPerson(served(), ANNA))!;
    expect(p).toMatchObject({
      slug: ANNA,
      name: 'АННА ПЕТРОВА',
      companies: 2,
      wonEur: 6000,
      asOf: '2026-09-10',
    });
    expect(p.roles.map((r) => [r.company.name, r.role])).toEqual([
      ['АЛФА ООД', 'manager'],
      ['БЕТА АД', 'board_of_directors'],
      ['АЛФА ООД', 'partner'],
    ]);
    expect(p.roles[0]!.company).toEqual({
      name: 'АЛФА ООД',
      eik: '111111111',
      href: '/companies/111111111',
    });
    expect(p.network.center).toMatchObject({ id: `rp:${ANNA}`, kind: 'person', hop: 0 });
    // The larger company first; each with the roles held there.
    expect(p.network.nodes.map((n) => n.id)).toEqual([
      `rp:${ANNA}`,
      'eik:222222222',
      'eik:111111111',
    ]);
    expect(p.network.edges.find((e) => e.to === 'eik:111111111')).toMatchObject({
      kind: 'role',
      roles: ['manager', 'partner'],
      current: true,
      weightEur: 0,
    });
  });

  it('marks the roles that ended', async () => {
    const p = (await getRegistryPerson(served(), BORIS))!;
    expect(p.roles.every((r) => r.removedOn)).toBe(true);
    expect(p.network.edges.every((e) => e.current === false)).toBe(true);
  });

  it('has no page for a person the register records only as an actual owner, nor for one it never gave', async () => {
    const db = served();
    expect(await getRegistryPerson(db, OWNER)).toBeNull();
    expect(await getRegistryPerson(db, hash('e'))).toBeNull();
  });
});

describe('the registry layer of the tie graph', () => {
  it('reaches from a company to its people, on to their other companies, and to the company that owns it', async () => {
    const net = await getCompanyTies(served(), 'eik:111111111');
    // Анна stands, so she comes before Борис; the companies they reach, the larger first; then the owner.
    expect(net.nodes.map((n) => [n.id, n.kind, n.hop])).toEqual([
      ['eik:111111111', 'company', 0],
      [`rp:${ANNA}`, 'person', 1],
      [`rp:${BORIS}`, 'person', 1],
      ['eik:222222222', 'company', 2],
      ['eik:333333333', 'company', 2],
      ['eik:444444444', 'company', 1],
    ]);
    const edge = (from: string, to: string) =>
      net.edges.find((e) => e.from === from && e.to === to)!;
    expect(edge(`rp:${ANNA}`, 'eik:111111111')).toMatchObject({
      roles: ['manager', 'partner'],
      current: true,
      directed: false,
    });
    expect(edge(`rp:${BORIS}`, 'eik:111111111')).toMatchObject({ current: false });
    expect(edge(`rp:${ANNA}`, 'eik:222222222')).toMatchObject({ roles: ['board_of_directors'] });
    expect(edge('eik:444444444', 'eik:111111111')).toMatchObject({
      roles: ['partner'],
      directed: true,
    });
    // Neither the actual owner nor the partner the register does not identify is drawn.
    expect(JSON.stringify(net)).not.toContain('САМО СОБСТВЕНИК');
    expect(JSON.stringify(net)).not.toContain('JOHN SMITH');
  });

  it('draws the company that owns another as a tie from owner to owned', async () => {
    const net = await getCompanyTies(served(), 'eik:333333333');
    expect(net.edges.find((e) => e.from === 'eik:222222222')).toMatchObject({
      to: 'eik:333333333',
      roles: ['sole_owner'],
      directed: true,
    });
  });

  it('draws between an authority’s suppliers the people they share, and the supplier that owns another', async () => {
    const net = await getAuthoritySupplierTies(served(), 'auth:100000001');
    expect(net.nodes.filter((n) => n.kind === 'person').map((n) => [n.id, n.hop])).toEqual([
      [`rp:${ANNA}`, 2],
      [`rp:${BORIS}`, 2],
    ]);
    const roles = net.edges.filter((e) => e.kind === 'role').map((e) => [e.from, e.to]);
    expect(roles).toEqual([
      [`rp:${ANNA}`, 'eik:111111111'],
      [`rp:${ANNA}`, 'eik:222222222'],
      [`rp:${BORIS}`, 'eik:111111111'],
      [`rp:${BORIS}`, 'eik:333333333'],
      ['eik:222222222', 'eik:333333333'],
    ]);
    // Вера is at one supplier only; the actual owner, at two, is never drawn.
    expect(JSON.stringify(net)).not.toContain(VERA);
    expect(JSON.stringify(net)).not.toContain(OWNER);
  });
});

describe('an environment without the registry tables', () => {
  it('serves the profiles without the layer rather than failing', async () => {
    const db = served({ withoutRegistry: true });
    expect(await getCompanyPeople(db, 'eik:111111111')).toEqual({ roles: [], asOf: null });
    expect(await getRegistryPerson(db, ANNA)).toBeNull();
  });

  it('still fails on any other error', async () => {
    await expect(
      registryRead(() => Promise.reject(new Error('D1_ERROR: boom')), 0),
    ).rejects.toThrow('boom');
  });
});

describe('identities', () => {
  it('addresses a person by the register’s identifier, and nothing else as one', () => {
    expect(registryPersonSlug(ANNA.toUpperCase())).toBe(ANNA);
    expect(registryPersonIdFromSlug(ANNA.toUpperCase())).toBe(ANNA);
    for (const bad of ['abc', 'g'.repeat(64), `${ANNA}0`])
      expect(registryPersonIdFromSlug(bad)).toBeNull();
  });

  it('reads the register for a 9-digit ЕИК only', () => {
    expect(partidaEik('eik:111111111')).toBe('111111111');
    expect(partidaEik('eik:1111111110001')).toBeNull();
    expect(partidaEik('name:ФИРМА')).toBeNull();
  });
});

describe('non-unique date-of-birth sources', () => {
  it('migrates old combined identities into source roles and keeps private roles out of old URLs', async () => {
    const db = served();
    open!.exec(
      `UPDATE registry_persons SET indent_type='BirthDate' WHERE indent IN ('${ANNA}','${OWNER}')`,
    );
    open!.exec(readFileSync(resolve(migrationsDir, '0019_registry_scoped_birthdates.sql'), 'utf8'));
    expect(await getRegistryPerson(db, ANNA)).toBeNull();
    const sources = await getRegistrySourceCompanies(db, ANNA);
    expect(sources.map((r) => r.eik)).toEqual(['111111111', '222222222']);
    expect(sources.every((r) => r.href?.startsWith('/companies/'))).toBe(true);
    expect(await getRegistrySourceCompanies(db, OWNER)).toEqual([]);
    expect(
      (await getCompanyPeople(db, 'eik:111111111')).roles.filter(
        (r) => r.holder.name === 'АННА ПЕТРОВА',
      ),
    ).toHaveLength(2);
    open!.exec(readFileSync(resolve(migrationsDir, '0019_registry_scoped_birthdates.sql'), 'utf8'));
    expect(await getRegistrySourceCompanies(db, ANNA)).toEqual(sources);
  });
});
