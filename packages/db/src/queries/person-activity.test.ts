import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { getPersonActivity, getRegistryOfficials } from './person-activity';
import { getPersonTimeline } from './person-timeline';
let db: DatabaseSync;
afterEach(() => db?.close());

it('historical declaration years do not acquire later contracts, even with a later omitted filing', async () => {
  const d1 = fixture();
  db.exec(`CREATE TABLE interest_link_history(link_key,later_declaration_year,registry_role_ended_on);
    INSERT INTO interest_link_history VALUES('l','2025',NULL);`);
  const activity = await getPersonActivity(
    d1,
    null,
    ['official'],
    new URLSearchParams('basis=matched'),
  );
  expect(activity.contracts.map((r) => r.id).sort()).toEqual(['a', 'b']);
  expect(activity.contracts.every((r) => r.duringDeclaration && !r.duringRole)).toBe(true);
});
function fixture() {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE registry_roles(subject_id,subject_kind,eik,role,added_on,removed_on);
    CREATE TABLE registry_deeds(eik,outcome,fetched_at);
    INSERT INTO registry_deeds VALUES('111111111','ok','2026-08-30T12:00:00Z');
    CREATE TABLE interest_links(person_id,eik,link_key,status,interest_class,first_declared_year,last_declared_year);
    CREATE TABLE interest_link_evidence(link_key,evidence_kind);
    CREATE TABLE interest_link_observations(link_key,declaration_id,kind,timing,reported_year);
    CREATE TABLE person_registry_links(person_id,registry_indent);
    CREATE TABLE bidders(id,name,eik_normalized);
    CREATE TABLE tenders(id,title,authority_id);
    CREATE TABLE authorities(id,name);
    CREATE TABLE authority_totals(authority_id);
    CREATE TABLE declarations(person_id,institution);
    CREATE TABLE declaration_metadata(declaration_id,declaration_type);
    INSERT INTO authority_totals VALUES('auth:1');
    INSERT INTO declarations VALUES('official','Община');
    CREATE TABLE contracts(id,contract_subject,bidder_id,tender_id,signed_at,amount_eur);
    INSERT INTO authorities VALUES('auth:1','Община');
    INSERT INTO bidders VALUES('eik:111111111','Компания','111111111');
    INSERT INTO tenders VALUES('t','Предмет','auth:1');
    INSERT INTO registry_roles VALUES('person','person','111111111','manager','2020-01-01','2021-01-01'),('person','person','111111111','partner','2020-01-01','2021-01-01'),('person','person','111111111','manager','2022-01-01',NULL);
    INSERT INTO interest_links VALUES('official','111111111','l','published','private_ownership','2020','2021');
    INSERT INTO interest_link_evidence VALUES('l','document');
    INSERT INTO contracts VALUES('a','Първи','eik:111111111','t','2020-06-01',100),('b','Прекъсване','eik:111111111','t','2021-01-01',200),('c','Повторна роля','eik:111111111','t','2022-06-01',300),('d','Без дата','eik:111111111','t',NULL,NULL);`);
  return d1FromSqlite(db);
}
it('deduplicates roles and declaration overlap, preserving gaps and unknown dates', async () => {
  const a = await getPersonActivity(
    fixture(),
    'person',
    ['official'],
    new URLSearchParams('basis=role'),
  );
  expect(a.total).toBe(2);
  expect(a.valueEur).toBe(400);
  expect(a.roleCount).toBe(2);
  expect(a.declaredCount).toBe(1);
  expect(a.contracts.map((r) => r.id).sort()).toEqual(['a', 'c']);
  const declared = await getPersonActivity(
    d1FromSqlite(db),
    'person',
    ['official'],
    new URLSearchParams(),
    'declaration',
  );
  expect(declared.contracts.find((r) => r.id === 'b')).toMatchObject({
    duringRole: false,
    duringDeclaration: true,
  });
  expect(a.contracts.find((r) => r.id === 'd')).toBeUndefined();
  expect(declared.contracts.find((r) => r.id === 'd')).toBeUndefined();
});
it('an open role supports contracts only through the last successful registry observation', async () => {
  const d1 = fixture();
  db.exec(
    "INSERT INTO contracts VALUES('later','След справката','eik:111111111','t','2026-08-31',500),('observed','На датата на справката','eik:111111111','t','2026-08-30',600)",
  );
  const activity = await getPersonActivity(d1, 'person', [], new URLSearchParams('basis=role'));
  expect(activity.contracts.some((r) => r.id === 'later')).toBe(false);
  expect(activity.contracts.some((r) => r.id === 'observed')).toBe(true);
  db.exec("UPDATE registry_deeds SET outcome='absent'");
  const absent = await getPersonActivity(d1, 'person', [], new URLSearchParams('basis=role'));
  expect(absent.contracts.map((r) => r.id)).toEqual(['a']); // closed historical role remains known
});
it('filters and paginates without changing the full aggregates', async () => {
  const d1 = fixture();
  const insert = db.prepare(
    "INSERT INTO contracts VALUES(?, 'Договор', 'eik:111111111','t','2022-08-01',10)",
  );
  for (let i = 0; i < 60; i++) insert.run(`extra-${i}`);
  const first = await getPersonActivity(
    d1,
    'person',
    ['official'],
    new URLSearchParams('basis=role'),
  );
  const next = await getPersonActivity(
    d1,
    'person',
    ['official'],
    new URLSearchParams('basis=role&page=2'),
  );
  expect(first.total).toBe(62);
  expect(next.total).toBe(62);
  expect(next.valueEur).toBe(first.valueEur);
  expect(next.filterCounts).toEqual(first.filterCounts);
  expect(first.filterCounts.company['111111111']).toBe(62);
  expect(first.contracts).toHaveLength(50);
  expect(next.contracts).toHaveLength(12);
  expect(new Set([...first.contracts, ...next.contracts].map((r) => r.id)).size).toBe(62);
});

it('counts each filter option against the other selections, including zero results, overlaps and undated contracts', async () => {
  const d1 = fixture();
  db.exec(`
    INSERT INTO authorities VALUES('auth:2','Втора община');
    INSERT INTO tenders VALUES('t2','Друг предмет','auth:2');
    INSERT INTO bidders VALUES('eik:222222222','Втора фирма','222222222'),('alias','Друго име на първата фирма','111111111');
    UPDATE contracts SET bidder_id='alias' WHERE id='c';
    INSERT INTO registry_roles VALUES('person','person','222222222','manager','2020-01-01','2021-01-01');
    INSERT INTO interest_links VALUES('official','222222222','family','published','family_ownership','2022','2023');
    INSERT INTO interest_link_evidence VALUES('family','document');
    INSERT INTO contracts VALUES
      ('e','Втора фирма — роля','eik:222222222','t','2020-06-01',500),
      ('f','Втора фирма — дял на свързано лице','eik:222222222','t2','2022-01-01',600),
      ('g','Втора фирма — следваща година','eik:222222222','t','2023-01-01',700),
      ('h','Втора фирма — без дата','eik:222222222','t2',NULL,800);
  `);
  const all = await getPersonActivity(d1, 'person', ['official'], new URLSearchParams());
  expect(all.total).toBe(8);
  expect(all.companies).toHaveLength(2); // one option per EIK, even across source names
  expect(all.filterCounts).toEqual({
    company: { '': 8, '111111111': 4, '222222222': 4 },
    authority: { '': 8, 'auth:1': 6, 'auth:2': 2 },
    year: { '': 8, '2020': 2, '2021': 1, '2022': 2, '2023': 1 }, // "all" includes unknown dates
    basis: { all: 8, matched: 6, context: 2, role: 3, declaration: 4, self: 2, family: 2 },
  });
  const filtered = await getPersonActivity(
    d1,
    'person',
    ['official'],
    new URLSearchParams('company=111111111&authority=auth:1&year=2022&basis=all'),
  );
  expect(filtered.total).toBe(1);
  expect(filtered.filterCounts).toEqual({
    company: { '': 1, '111111111': 1, '222222222': 0 },
    authority: { '': 1, 'auth:1': 1, 'auth:2': 0 },
    year: { '': 4, '2020': 1, '2021': 1, '2022': 1, '2023': 0 },
    basis: { all: 1, matched: 1, context: 0, role: 1, declaration: 0, self: 0, family: 0 },
  });
  const family = await getPersonActivity(
    d1,
    'person',
    ['official'],
    new URLSearchParams('company=222222222&authority=auth:2&year=2022&basis=family'),
  );
  expect(family.total).toBe(1);
  expect(family.filterCounts).toEqual({
    company: { '': 1, '111111111': 0, '222222222': 1 },
    authority: { '': 1, 'auth:1': 0, 'auth:2': 1 },
    year: { '': 1, '2020': 0, '2021': 0, '2022': 1, '2023': 0 },
    basis: { all: 1, matched: 1, context: 0, role: 0, declaration: 1, self: 0, family: 1 },
  });
  const none = await getPersonActivity(
    d1,
    'person',
    ['official'],
    new URLSearchParams('company=222222222&authority=auth:2&year=2022&basis=self'),
  );
  expect(none.total).toBe(0);
  expect(none.filterCounts.company).toEqual({ '': 0, '111111111': 0, '222222222': 0 });
  expect(none.filterCounts.basis.family).toBe(1); // alternatives remain discoverable
  expect(none.companies).toEqual(all.companies);
  expect(none.yearOptions).toEqual(all.yearOptions);
});
it('never includes held interests or assigns a family company registry role to the declarant', async () => {
  const d1 = fixture();
  db.exec("UPDATE interest_links SET status='held'");
  expect(
    (await getPersonActivity(d1, null, ['official'], new URLSearchParams('basis=role'))).total,
  ).toBe(0);
  db.exec("UPDATE interest_links SET status='published', interest_class='family_ownership'");
  const a = await getPersonActivity(d1, null, ['official'], new URLSearchParams('basis=role'));
  expect(a.total).toBe(0);
  expect(a.roleCount).toBe(0);
  const declared = await getPersonActivity(
    d1,
    null,
    ['official'],
    new URLSearchParams(),
    'declaration',
  );
  expect(declared.total).toBe(2);
});

it('unifies the valid periods once, with explicit own/family provenance and a strict personal-role filter', async () => {
  const d1 = fixture();
  const union = await getPersonActivity(
    d1,
    'person',
    ['official'],
    new URLSearchParams('basis=matched'),
  );
  expect(union.contracts.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
  expect(union.total).toBe(3);
  expect(union.valueEur).toBe(600);
  expect(union.contracts.find((r) => r.id === 'a')).toMatchObject({
    duringRole: true,
    declarationBasis: 1,
  });
  db.exec("UPDATE interest_links SET interest_class='family_ownership'");
  const family = await getPersonActivity(
    d1,
    null,
    ['official'],
    new URLSearchParams('basis=matched'),
  );
  expect(family.total).toBe(2);
  expect(family.contracts.every((r) => !r.duringRole && r.declarationBasis === 2)).toBe(true);
  const roles = await getPersonActivity(d1, null, ['official'], new URLSearchParams('basis=role'));
  expect(roles.total).toBe(0);
  expect(roles.companyCount).toBe(0);
  expect(roles.companies).toHaveLength(1); // still discoverable, even when this basis returns no rows
  const self = await getPersonActivity(d1, null, ['official'], new URLSearchParams('basis=self'));
  expect(self.total).toBe(0);
});

it('the shared timeline covers all contracts without the 500-card limit and separates historical observations', async () => {
  const d1 = fixture();
  db.exec(`
    INSERT INTO interest_link_observations VALUES('l','d1','shares','annual','2020'),('l','d2','participation','prior','2025');`);
  const put = db.prepare(
    "INSERT INTO contracts VALUES(?,'Допълнителен','eik:111111111','t','2022-08-01',10)",
  );
  for (let i = 0; i < 605; i++) put.run(`extra-${i}`);
  const result = await getPersonTimeline(d1, 'person', ['official']);
  expect(result.contracts.reduce((n, r) => n + r.contracts, 0)).toBe(609);
  expect(result.contracts.find((r) => r.year === '2022')).toMatchObject({
    contracts: 606,
    role: 606,
    declared: 0,
    eligible: 606,
  });
  expect(result.contracts.find((r) => r.year === null)).toMatchObject({
    contracts: 1,
    eligible: 0,
  });
  expect(result.observations).toHaveLength(2);
  expect(result.observations.find((o) => o.timing === 'prior')!.reportedYear).toBe('2025');
});

it('includes every proven source identity only when the canonical person has a public interest', async () => {
  const d1 = fixture();
  db.exec(
    "INSERT INTO person_registry_links VALUES('official','canonical'),('alias-without-own-link','canonical'),('unrelated','other')",
  );
  expect(await getRegistryOfficials(d1, 'canonical')).toEqual([
    'alias-without-own-link',
    'official',
  ]);
  expect(await getRegistryOfficials(d1, 'other')).toEqual([]);
});

it('defaults to all contracts, preserving unknown dates and separating contextual amounts', async () => {
  const d1 = fixture();
  const all = await getPersonActivity(d1, 'person', ['official'], new URLSearchParams());
  expect(all.total).toBe(4);
  expect(all.valueEur).toBe(600);
  expect(all.declaredCount).toBe(2);
  expect(all.roleCount).toBe(2);
  expect(all.contracts.find((c) => c.id === 'd')).toMatchObject({
    duringRole: false,
    duringDeclaration: false,
    signedAt: null,
  });
  expect(all.yearOptions).toEqual(['2022', '2021', '2020']);
  const context = await getPersonActivity(
    d1,
    null,
    ['official'],
    new URLSearchParams('basis=context'),
  );
  expect(context.contracts.map((c) => c.id).sort()).toEqual(['c', 'd']);
  expect(context.valueEur).toBe(300);
  const filtered = await getPersonActivity(
    d1,
    null,
    ['official'],
    new URLSearchParams('company=111111111&year=2022&basis=context'),
  );
  expect(filtered.total).toBe(1);
  expect(filtered.years).toEqual([{ year: '2022', contracts: 1, valueEur: 300 }]);
  expect(filtered.byAuthority[0]).toMatchObject({ contracts: 1, valueEur: 300 });
  expect(filtered.yearOptions).toEqual(all.yearOptions);
});

it('disputed inventories retain all company contracts, exclude disputed years, and keep independent registry timing', async () => {
  const d1 = fixture();
  db.exec(`INSERT INTO interest_link_observations VALUES('l','positive','shares','annual','2020'),('l','other','shares','not_listed','2020');
    INSERT INTO person_registry_links VALUES('official','person'),('alias','person');
    INSERT INTO interest_links VALUES('alias','111111111','alias-l','published','private_ownership','2020','2021');
    INSERT INTO interest_link_evidence VALUES('alias-l','document');`);
  const all = await getPersonActivity(d1, 'person', ['official', 'alias'], new URLSearchParams());
  expect(all.total).toBe(4);
  expect(all.contracts.find((r) => r.id === 'a')).toMatchObject({
    duringRole: true,
    duringDeclaration: false,
    declarationBasis: 0,
  });
  expect(all.contracts.find((r) => r.id === 'b')).toMatchObject({
    duringRole: false,
    duringDeclaration: true,
  });
  const declared = await getPersonActivity(
    d1,
    null,
    ['alias'],
    new URLSearchParams('basis=declaration'),
  );
  expect(declared.contracts.map((r) => r.id)).toEqual(['b']); // aliases cannot bypass the disputed year
  db.exec("UPDATE interest_links SET interest_class='family_ownership' WHERE link_key='alias-l'");
  expect(
    (await getPersonActivity(d1, null, ['alias'], new URLSearchParams('basis=family'))).total,
  ).toBe(2); // a different holder is independent
  db.exec("UPDATE interest_links SET status='held'");
  expect(
    (await getPersonActivity(d1, null, ['official', 'alias'], new URLSearchParams())).total,
  ).toBe(0);
});
