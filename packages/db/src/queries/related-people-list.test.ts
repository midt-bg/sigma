import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import {
  getRelatedPersonRows,
  getRelatedPersonHeadline,
  getRegistryRolePersonRows,
} from './related-people-list';
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

it('lists people the register places at a winner without a declared stake, by their office years', async () => {
  const db = new DatabaseSync(':memory:');
  const H = 'h'.repeat(64);
  try {
    db.exec(`CREATE TABLE persons(id PRIMARY KEY,name);
      CREATE TABLE person_entities(id PRIMARY KEY,registry_indent);
      CREATE TABLE person_sources(entity_id,namespace,active);
      CREATE TABLE interest_links(person_id,status,interest_class);
      CREATE TABLE registry_roles(subject_id,subject_kind,role,eik);
      CREATE TABLE declarations(person_id,institution,position,declared_year);
      CREATE TABLE bidders(id PRIMARY KEY,eik_normalized,name);
      CREATE TABLE company_totals(bidder_id,contracts);
      CREATE TABLE contracts(id PRIMARY KEY,bidder_id,tender_id,signed_at,amount_eur);
      CREATE TABLE tenders(id PRIMARY KEY,authority_id);
      INSERT INTO persons VALUES('p','Лице Роля'),('q','Лице Дял'),('r','Лице Без');
      INSERT INTO person_entities VALUES('p','${H}'),('q','${'q'.repeat(64)}'),('r','${'r'.repeat(64)}');
      INSERT INTO person_sources VALUES('p','cacbg',1),('q','cacbg',1),('r','tr',1);
      INSERT INTO interest_links VALUES('q','published','private_ownership');
      INSERT INTO registry_roles VALUES('${H}','person','manager','111111111'),('${H}','person','beneficial_owner','222222222'),
        ('${'q'.repeat(64)}','person','manager','111111111'),('${'r'.repeat(64)}','person','manager','111111111');
      INSERT INTO declarations VALUES('p','Община','Кмет','2020');
      INSERT INTO bidders VALUES('b1','111111111','Изпълнител'),('b2','222222222','Друг');
      INSERT INTO company_totals VALUES('b1',2),('b2',1);
      INSERT INTO tenders VALUES('t','a'),('t2','other');
      INSERT INTO contracts VALUES('c1','b1','t','2020-05-01',100),('c2','b1','t2','2022-05-01',50),('c3','b2','t','2020-01-01',999);`);
    const rows = await getRegistryRolePersonRows(d1FromSqlite(db));
    expect(rows).toHaveLength(1); // q has a declared stake, r never filed a declaration
    expect(rows[0]).toMatchObject({
      official: 'Лице Роля',
      personIdentity: H,
      stakeKind: 'registry',
      companyCount: 1, // the actual-owner role is not a public role
      contractCount: 2,
      contractValueEur: 150,
      contemporaneousValueEur: 100,
      hasContemporaneous: true,
      companies: [{ eik: '111111111', company: 'Изпълнител', self: 0, family: 0, registry: 1 }],
    });
    expect(await getRegistryRolePersonRows(d1FromSqlite(db), 'other')).toHaveLength(1);
    expect(await getRegistryRolePersonRows(d1FromSqlite(db), 'nobody')).toEqual([]);
  } finally {
    db.close();
  }
});

it('names the only company of a single-company declarant, and tells own, family and mixed stakes apart', async () => {
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
      INSERT INTO bidders VALUES('b1','111111111','Първа'),('b2','222222222','Втора');
      INSERT INTO contracts VALUES('c1','b1','t','2020-01-01',100),('c2','b2','t','2020-01-01',200);
      INSERT INTO persons VALUES('person:self','Собствен дял'),('person:family','Дял на свързано лице'),('person:mixed','Два вида дял');
      INSERT INTO interest_links VALUES
        ('s','person:self','111111111','published','private_ownership','none','2020','2020'),
        ('f','person:family','222222222','published','family_ownership','none','2020','2020'),
        ('m1','person:mixed','111111111','published','private_ownership','none','2020','2020'),
        ('m2','person:mixed','222222222','published','family_ownership','none','2020','2020');
      INSERT INTO interest_link_evidence SELECT link_key,'document' FROM interest_links;`);
    const rows = await getRelatedPersonRows(d1FromSqlite(db));
    const by = (official: string) => rows.find((r) => r.official === official)!;
    expect(by('Собствен дял')).toMatchObject({
      stakeKind: 'self',
      companyCount: 1,
      soleCompany: { company: 'Първа', eik: '111111111' },
    });
    expect(by('Дял на свързано лице')).toMatchObject({
      stakeKind: 'family',
      soleCompany: { company: 'Втора', eik: '222222222' },
    });
    expect(by('Два вида дял')).toMatchObject({
      stakeKind: 'mixed',
      companyCount: 2,
      soleCompany: null,
      contractValueEur: 300,
      companies: [
        { eik: '222222222', company: 'Втора', self: 0, family: 1 },
        { eik: '111111111', company: 'Първа', self: 1, family: 0 },
      ],
    });
  } finally {
    db.close();
  }
});
