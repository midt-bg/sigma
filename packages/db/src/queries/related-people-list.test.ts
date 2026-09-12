import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { getRelatedPersonRows, getRelatedPersonHeadline } from './related-people-list';
it('groups beyond 1000 source links, preserving identity, distinct pairs and contract unions', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE persons(id PRIMARY KEY,name);
      CREATE TABLE interest_links(link_key,person_id,eik,status,interest_class,own_institution,first_declared_year,last_declared_year);
      CREATE TABLE interest_link_evidence(link_key,evidence_kind);
      CREATE TABLE interest_link_history(link_key,later_declaration_year,registry_role_ended_on);
      CREATE TABLE person_registry_links(person_id,registry_indent);
      CREATE TABLE declarations(person_id,institution,position,declared_year);
      CREATE TABLE bidders(id PRIMARY KEY,eik_normalized,name);
      CREATE TABLE contracts(id PRIMARY KEY,bidder_id,tender_id,signed_at,amount_eur);
      CREATE TABLE tenders(id PRIMARY KEY,authority_id);CREATE TABLE authorities(id PRIMARY KEY);
      INSERT INTO authorities VALUES('a');INSERT INTO tenders VALUES('t','a');
      INSERT INTO bidders VALUES('b','123456789','Компания');
      INSERT INTO contracts VALUES('c1','b','t','2020-02-01',100),('c2','b','t','2022-02-01',200),('c3','b','t','2021-01-01',300);`);
    const p = db.prepare('INSERT INTO persons VALUES(?,?)');
    const l = db.prepare(
      "INSERT INTO interest_links VALUES(?,?,'123456789','published','private_ownership','no',?,?)",
    );
    const e = db.prepare("INSERT INTO interest_link_evidence VALUES(?,'document')");
    for (let i = 0; i < 1205; i++) {
      p.run(`person:${i}`, `Лице ${i}`);
      l.run(`l${i}`, `person:${i}`, '2020', '2020');
      e.run(`l${i}`);
    }
    db.exec(`INSERT INTO person_registry_links VALUES('person:0','canonical'),('person:1204','canonical');
      UPDATE interest_links SET first_declared_year='2022',last_declared_year='2022' WHERE person_id='person:1204';
      INSERT INTO declarations VALUES('person:0','Институция А','Роля','2020'),('person:1204','Институция Б','Друга роля','2022');`);
    const d1 = d1FromSqlite(db);
    const rows = await getRelatedPersonRows(d1);
    expect(rows).toHaveLength(1204);
    const combined = rows.find((r) => r.personIdentity === 'canonical')!;
    expect(combined).toMatchObject({
      companyCount: 1,
      contractCount: 3,
      contractValueEur: 600,
      contemporaneousValueEur: 300,
    });
    expect(combined.declaredOffices).toHaveLength(2);
    expect(
      await getRelatedPersonHeadline(
        d1,
        rows.map((r) => r.personIdentity),
      ),
    ).toEqual({ officialCount: 1204, linkCount: 1204, totalEur: 600, contemporaneousEur: 300 });
    expect(await getRelatedPersonRows(d1, 'unrelated')).toEqual([]);
    expect(await getRelatedPersonHeadline(d1, [])).toEqual({
      officialCount: 0,
      linkCount: 0,
      totalEur: 0,
      contemporaneousEur: 0,
    });
  } finally {
    db.close();
  }
});
