import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { getPersonActivity } from './person-activity';
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
    new URLSearchParams('basis=all'),
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
    CREATE TABLE bidders(id,name,eik_normalized);
    CREATE TABLE tenders(id,title,authority_id);
    CREATE TABLE authorities(id,name);
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
  const a = await getPersonActivity(fixture(), 'person', ['official'], new URLSearchParams());
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
  const activity = await getPersonActivity(d1, 'person', [], new URLSearchParams());
  expect(activity.contracts.some((r) => r.id === 'later')).toBe(false);
  expect(activity.contracts.some((r) => r.id === 'observed')).toBe(true);
  db.exec("UPDATE registry_deeds SET outcome='absent'");
  const absent = await getPersonActivity(d1, 'person', [], new URLSearchParams());
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
    new URLSearchParams('period=role'),
  );
  const next = await getPersonActivity(
    d1,
    'person',
    ['official'],
    new URLSearchParams('period=role&page=2'),
  );
  expect(first.total).toBe(62);
  expect(next.total).toBe(62);
  expect(next.valueEur).toBe(first.valueEur);
  expect(first.contracts).toHaveLength(50);
  expect(next.contracts).toHaveLength(12);
  expect(new Set([...first.contracts, ...next.contracts].map((r) => r.id)).size).toBe(62);
});
it('never includes held interests or assigns a family company registry role to the declarant', async () => {
  const d1 = fixture();
  db.exec("UPDATE interest_links SET status='held'");
  expect((await getPersonActivity(d1, null, ['official'], new URLSearchParams())).total).toBe(0);
  db.exec("UPDATE interest_links SET status='published', interest_class='family_ownership'");
  const a = await getPersonActivity(d1, null, ['official'], new URLSearchParams());
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
    new URLSearchParams('basis=all'),
  );
  expect(union.contracts.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
  expect(union.total).toBe(3);
  expect(union.valueEur).toBe(600);
  expect(union.contracts.find((r) => r.id === 'a')).toMatchObject({
    duringRole: true,
    declarationBasis: 1,
  });
  db.exec("UPDATE interest_links SET interest_class='family_ownership'");
  const family = await getPersonActivity(d1, null, ['official'], new URLSearchParams('basis=all'));
  expect(family.total).toBe(2);
  expect(family.contracts.every((r) => !r.duringRole && r.declarationBasis === 2)).toBe(true);
  const roles = await getPersonActivity(d1, null, ['official'], new URLSearchParams('basis=role'));
  expect(roles.total).toBe(0);
  expect(roles.companyCount).toBe(0);
  expect(roles.companies).toHaveLength(1); // still discoverable, even when this basis returns no rows
  const self = await getPersonActivity(d1, null, ['official'], new URLSearchParams('basis=self'));
  expect(self.total).toBe(0);
});
