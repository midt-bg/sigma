/// <reference types="node" />
// The declared-stake detail reads against a real SQLite built from the production migrations: which of an
// official's filings a link cites, a link whose declared years are unknown, the page read without its
// contracts, and the compact declarants section of a company profile. The unit tests beside this one use a
// fake D1 that never returns a filing, so the per-link document filter is only exercised here.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { getCompanyConflicts, getCompanyDeclarants, getOfficialConflicts } from './related-persons';

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

// Мила owns ПЪРВА (a stake whose declared years are unknown) and ВТОРА (declared 2022); each of her two
// filings resolves to one of them. Недко's relative holds a stake in ПЪРВА (declared 2021); his own stake in
// ВТОРА is held back.
const FIXTURE = `
INSERT INTO authorities (id, name) VALUES ('auth:500000000', 'ОБЩИНА ПРИМЕР');
INSERT INTO bidders (id, name, bulstat, eik_normalized, eik_valid, kind) VALUES
  ('eik:500000001', 'ПЪРВА ФИРМА ООД', '500000001', '500000001', 1, 'company'),
  ('eik:500000002', 'ВТОРА ФИРМА ООД', '500000002', '500000002', 1, 'company');
INSERT INTO tenders (id, source_id, title, authority_id, procedure_type) VALUES
  ('t:1', 'UNP-1', 'Ремонт', 'auth:500000000', 'Открита процедура');
INSERT INTO contracts (id, tender_id, bidder_id, amount, currency, signed_at, amount_eur) VALUES
  ('c:1', 't:1', 'eik:500000001', 100, 'EUR', '2021-03-01', 100),
  ('c:2', 't:1', 'eik:500000001', 200, 'EUR', '2023-03-01', 200),
  ('c:3', 't:1', 'eik:500000002', 300, 'EUR', '2022-03-01', 300);
INSERT INTO persons (id, name) VALUES ('person:mila', 'Мила Тестова'), ('person:nedko', 'Недко Тестов');
INSERT INTO declarations (id, person_id, xml_file, folder_year, declared_year, template, institution, position,
                          source_url) VALUES
  ('decl:m1', 'person:mila', 'm1.xml', '2022', '2021', 'assets', 'ОБЩИНА ПРИМЕР', 'Съветник',
   'https://register.cacbg.bg/2022/m1.xml'),
  ('decl:m2', 'person:mila', 'm2.xml', '2023', '2022', 'assets', 'ОБЩИНА ПРИМЕР', 'Съветник',
   'https://register.cacbg.bg/2023/m2.xml');
INSERT INTO declaration_companies (declaration_id, eik, match_method) VALUES
  ('decl:m1', '500000001', 'declared_eik'),
  ('decl:m2', '500000002', 'declared_eik');
INSERT INTO interest_links (id, link_key, person_id, bidder_id, eik, entity_key, match_method, matcher_version,
                            publish_tier, relation, interest_class, first_declared_year, last_declared_year,
                            contract_count, status) VALUES
  ('il:m1', 'person:mila|500000001', 'person:mila', 'eik:500000001', '500000001', 'ПЪРВА ФИРМА',
   'declared_eik', 'v1', 'A_eik', 'owns', 'private_ownership', NULL, NULL, 2, 'published'),
  ('il:m2', 'person:mila|500000002', 'person:mila', 'eik:500000002', '500000002', 'ВТОРА ФИРМА',
   'declared_eik', 'v1', 'A_eik', 'owns', 'private_ownership', '2022', '2022', 1, 'published'),
  ('il:n1', 'person:nedko|500000001|family', 'person:nedko', 'eik:500000001', '500000001', 'ПЪРВА ФИРМА',
   'exact_name_key', 'v1', 'B_distinctive', 'related', 'family_ownership', '2021', '2021', 2, 'published'),
  ('il:n2', 'person:nedko|500000002', 'person:nedko', 'eik:500000002', '500000002', 'ВТОРА ФИРМА',
   'exact_name_key', 'v1', 'B_distinctive', 'owns', 'private_ownership', '2022', '2022', 1, 'held');
INSERT INTO interest_link_evidence (link_key, evidence_kind, registry_role, lookup_date, rules_version,
                                    live_status)
  SELECT link_key, 'document', 'owner', '2026-09-01', 'tr-rules-1', 'live' FROM interest_links;
`;

let open: DatabaseSync | null = null;

function served(): D1Database {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of migrations) sqlite.exec(readFileSync(resolve(migrationsDir, f), 'utf8'));
  sqlite.exec(FIXTURE);
  open = sqlite;
  return d1FromSqlite(sqlite);
}

afterEach(() => {
  open?.close();
  open = null;
});

const slugs = (contracts: Record<string, { contractSlug: string }[]>) =>
  Object.fromEntries(
    Object.entries(contracts).map(([eik, rows]) => [eik, rows.map((c) => c.contractSlug)]),
  );

describe('an official’s page', () => {
  it('cites on each link only the filings that name its company, and keeps a link with no declared years', async () => {
    const official = (await getOfficialConflicts(served(), 'person:mila'))!;
    expect(official.official).toBe('Мила Тестова');
    expect(
      official.links.map((l) => [
        l.eik,
        l.firstDeclaredYear,
        l.lastDeclaredYear,
        l.contemporaneous,
      ]),
    ).toEqual([
      ['500000002', '2022', '2022', true],
      ['500000001', null, null, false],
    ]);
    expect(official.links.map((l) => l.declarations?.map((d) => d.id))).toEqual([
      ['decl:m2'],
      ['decl:m1'],
    ]);
    // With no declared window there is nothing to put first: the latest contract leads.
    expect(slugs(official.contracts)).toEqual({ '500000001': ['2', '1'], '500000002': ['3'] });
  });

  it('reads the links and their filings without the contracts when asked to', async () => {
    const official = (await getOfficialConflicts(served(), 'person:mila', { contracts: false }))!;
    expect(official.contracts).toEqual({});
    expect(official.links.map((l) => l.declarations?.map((d) => d.id))).toEqual([
      ['decl:m2'],
      ['decl:m1'],
    ]);
  });
});

describe('a company’s page', () => {
  it('orders the contracts of any declarant’s window first, and cites each declarant’s own filings', async () => {
    const company = (await getCompanyConflicts(served(), '500000001'))!;
    expect(company.company).toBe('ПЪРВА ФИРМА ООД');
    expect(
      company.links.map((l) => [l.official, l.relation, l.declarations?.map((d) => d.id)]),
    ).toEqual([
      ['Недко Тестов', 'related', []],
      ['Мила Тестова', 'owns', ['decl:m1']],
    ]);
    expect(slugs(company.contracts)).toEqual({ '500000001': ['1', '2'] });
  });
});

describe('getCompanyDeclarants', () => {
  it('lists every surfaced declarant of a company, strongest first, without documents or contracts', async () => {
    const db = served();
    const declarants = await getCompanyDeclarants(db, '500000001');
    expect(declarants.map((l) => l.linkKey)).toEqual([
      'person:nedko|500000001|family',
      'person:mila|500000001',
    ]);
    for (const l of declarants) expect(l).not.toHaveProperty('declarations');
    // A held stake is never a declarant, and a company with none has an empty section.
    expect((await getCompanyDeclarants(db, '500000002')).map((l) => l.official)).toEqual([
      'Мила Тестова',
    ]);
    expect(await getCompanyDeclarants(db, '599999999')).toEqual([]);
  });
});
