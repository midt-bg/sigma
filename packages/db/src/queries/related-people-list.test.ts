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
      CREATE TABLE interest_link_observations(link_key,declaration_id,kind,timing,reported_year);
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
      db.prepare('INSERT INTO declarations VALUES(?,?,?,?)').run(
        `person:${i}`,
        'Институция',
        'Съветник',
        '2020',
      );
    }
    db.exec(`INSERT INTO person_registry_links VALUES('person:0','canonical'),('person:1204','canonical');
      UPDATE interest_links SET first_declared_year='2022',last_declared_year='2022' WHERE person_id='person:1204';
      INSERT INTO declarations VALUES('person:0','Институция А','Роля','2020'),('person:1204','Институция Б','Друга роля','2022');
      INSERT INTO bidders VALUES
        ('own-small-b','2','Собствена малка'),('own-big-b','3','Собствена голяма'),
        ('rest-big-b','4','Останала голяма'),('rest-small-b','5','Останала малка'),
        ('window-small-b','6','Съвпадение малка'),('window-big-b','7','Съвпадение голяма');
      INSERT INTO persons VALUES
        ('person:own-small','Собствена малка'),('person:own-big','Собствена голяма'),
        ('person:rest-big','Останала голяма'),('person:rest-small','Останала малка'),
        ('person:window-small','Съвпадение малка'),('person:window-big','Съвпадение голяма');
      INSERT INTO interest_links VALUES
        ('own-small','person:own-small','2','published','private_ownership','exact','2020','2020'),
        ('own-big','person:own-big','3','published','private_ownership','exact','2020','2020'),
        ('rest-big','person:rest-big','4','published','private_ownership','none','2020','2020'),
        ('rest-small','person:rest-small','5','published','private_ownership','none','2020','2020'),
        ('window-small','person:window-small','6','published','private_ownership','none','2020','2020'),
        ('window-big','person:window-big','7','published','private_ownership','none','2020','2020');
      INSERT INTO interest_link_evidence VALUES
        ('own-small','document'),('own-big','document'),('rest-big','document'),
        ('rest-small','document'),('window-small','document'),('window-big','document');
      INSERT INTO declarations VALUES('person:window-small','Институция','Съветник','2020'),('person:window-big','Институция','Съветник','2020');
      INSERT INTO contracts VALUES
        ('own-small-c','own-small-b','t','2010-01-01',1),
        ('own-big-c','own-big-b','t','2010-01-01',2),
        ('rest-big-c','rest-big-b','t','2010-01-01',10000),
        ('rest-small-c','rest-small-b','t','2010-01-01',1),
        ('window-small-c','window-small-b','t','2020-01-01',50),
        ('window-big-c','window-big-b','t','2020-01-01',5000);`);
    const d1 = d1FromSqlite(db);
    const rows = await getRelatedPersonRows(d1);
    expect(rows).toHaveLength(1210);
    expect(rows.slice(0, 2).map((r) => r.official)).toEqual([
      'Собствена голяма',
      'Собствена малка',
    ]);
    expect(rows.findIndex((r) => r.official === 'Съвпадение малка')).toBeLessThan(
      rows.findIndex((r) => r.official === 'Останала голяма'),
    );
    expect(rows.findIndex((r) => r.official === 'Съвпадение голяма')).toBeLessThan(
      rows.findIndex((r) => r.official === 'Съвпадение малка'),
    );
    expect(rows.slice(-2).map((r) => r.official)).toEqual(['Останала голяма', 'Останала малка']);
    const combined = rows.find((r) => r.personIdentity === 'canonical')!;
    expect(combined).toMatchObject({
      companyCount: 1,
      contractCount: 3,
      contractValueEur: 600,
      contemporaneousValueEur: 300,
    });
    expect(combined.declaredOffices).toHaveLength(4);
    expect(
      await getRelatedPersonHeadline(
        d1,
        rows.map((r) => r.personIdentity),
      ),
    ).toEqual({
      officialCount: 1210,
      linkCount: 1210,
      totalEur: 15654,
      contemporaneousEur: 5350,
    });
    expect(await getRelatedPersonRows(d1, 'unrelated')).toEqual([]);
    expect(await getRelatedPersonHeadline(d1, [])).toEqual({
      officialCount: 0,
      linkCount: 0,
      totalEur: 0,
      contemporaneousEur: 0,
    });
    // An evidenced alias can supply an office year without declaring this company at all.
    db.exec(`INSERT INTO persons VALUES('alias','Лице');
      INSERT INTO person_registry_links VALUES('alias','canonical');
      INSERT INTO declarations VALUES('alias','Институция','Съветник','2021'),('alias','Институция','Съветник','2021');
      INSERT INTO contracts VALUES('unknown-amount','b','t','2022-03-01',NULL),('zero-amount','b','t','2022-04-01',0),('unknown-date','b','t',NULL,50);`);
    const withAlias = (await getRelatedPersonRows(d1)).find(
      (r) => r.personIdentity === 'canonical',
    )!;
    expect(withAlias).toMatchObject({
      contemporaneousValueEur: 600,
      contractCount: 6,
      contractValueEur: 650,
    });
    // Removing office evidence does not change the company link, but must remove the year's contracts.
    db.exec("UPDATE declarations SET position='' WHERE declared_year='2021'");
    expect(
      (await getRelatedPersonRows(d1)).find((r) => r.personIdentity === 'canonical'),
    ).toMatchObject({ contemporaneousValueEur: 300 });
  } finally {
    db.close();
  }
});
