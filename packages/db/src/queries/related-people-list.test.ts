import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { OFFICE_ORGANIZATIONS } from '@sigma/shared';
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
      CREATE TABLE interest_link_evidence(link_key,evidence_kind,matched_fact TEXT GENERATED ALWAYS AS (NULL) VIRTUAL);
      CREATE TABLE interest_link_observations(link_key,declaration_id,kind,timing,reported_year);
      CREATE TABLE person_registry_links(person_id,registry_indent);
      CREATE TABLE declarations(id,person_id,institution,position,declared_year,category TEXT GENERATED ALWAYS AS (NULL) VIRTUAL);
      CREATE TABLE IF NOT EXISTS declaration_metadata(declaration_id,declaration_type,declared_on,submitted_on);
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
      db.prepare('INSERT INTO declarations VALUES(?,?,?,?,?)').run(
        `d${i}`,
        `person:${i}`,
        'Институция',
        'Съветник',
        '2020',
      );
    }
    db.exec(`INSERT INTO person_registry_links VALUES('person:0','canonical'),('person:1204','canonical');
      UPDATE interest_links SET first_declared_year='2022',last_declared_year='2022' WHERE person_id='person:1204';
      INSERT INTO declarations VALUES('x0','person:0','Институция А','Роля','2020'),('x1204','person:1204','Институция Б','Друга роля','2022');
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
      INSERT INTO declarations VALUES('ws','person:window-small','Институция','Съветник','2020'),('wb','person:window-big','Институция','Съветник','2020');
      INSERT INTO contracts VALUES
        ('own-small-c','own-small-b','t','2010-01-01',1),
        ('own-big-c','own-big-b','t','2010-01-01',2),
        ('rest-big-c','rest-big-b','t','2010-01-01',10000),
        ('rest-small-c','rest-small-b','t','2010-01-01',1),
        ('window-small-c','window-small-b','t','2020-01-01',50),
        ('window-big-c','window-big-b','t','2020-01-01',5000);
      ALTER TABLE interest_links ADD COLUMN relation TEXT;
      UPDATE interest_links SET relation=CASE interest_class WHEN 'family_ownership' THEN 'related' ELSE 'owns' END;
    `);
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
    // The authority that DID pay still finds them, and the filter reads its payees once rather than
    // asking per link: as a correlated EXISTS this cost D1 „exceeded its CPU time limit and was reset"
    // for any authority above roughly two thousand contracts, which is most of the interesting ones.
    expect((await getRelatedPersonRows(d1, 'a')).length).toBe(rows.length);
    expect(await getRelatedPersonHeadline(d1, [])).toEqual({
      officialCount: 0,
      linkCount: 0,
      totalEur: 0,
      contemporaneousEur: 0,
    });
    // An evidenced alias can supply an office year without declaring this company at all — but an office
    // year is only half of it now: the contract must ALSO fall inside a declared stake. The 2021 contract
    // does not, so the alias's 2021 office year no longer drags it in by itself.
    db.exec(`INSERT INTO persons VALUES('alias','Лице');
      INSERT INTO person_registry_links VALUES('alias','canonical');
      INSERT INTO declarations VALUES('a1','alias','Институция','Съветник','2021'),('a2','alias','Институция','Съветник','2021');
      INSERT INTO contracts VALUES('unknown-amount','b','t','2022-03-01',NULL),('zero-amount','b','t','2022-04-01',0),('unknown-date','b','t',NULL,50);`);
    const withAlias = (await getRelatedPersonRows(d1)).find(
      (r) => r.personIdentity === 'canonical',
    )!;
    expect(withAlias).toMatchObject({
      contemporaneousValueEur: 300, // 2020 (100) + 2022 (200); the 2021 contract is inside no stake
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

it('lists people the register records as owners of a winner without a declared stake, counting only what falls inside both the role and the office', async () => {
  const db = new DatabaseSync(':memory:');
  const H = 'h'.repeat(64);
  try {
    db.exec(`CREATE TABLE persons(id PRIMARY KEY,name);
      CREATE TABLE person_registry_links(person_id PRIMARY KEY,registry_indent);
      CREATE TABLE interest_links(person_id,status,interest_class,eik,relation TEXT GENERATED ALWAYS AS (NULL) VIRTUAL,
        link_key TEXT GENERATED ALWAYS AS (person_id || ':' || eik) VIRTUAL);
      CREATE TABLE interest_link_evidence(link_key,evidence_kind);
      CREATE TABLE registry_roles(subject_id,subject_kind,role,eik,added_on DEFAULT '2019-01-01',removed_on,uncertain_after);
      -- An open role counts only up to the last successful read of the partida.
      CREATE TABLE registry_deeds(eik,outcome,fetched_at,name);
      INSERT INTO registry_deeds VALUES('111111111','ok','2026-09-01','ИЗПЪЛНИТЕЛ'),('222222222','ok','2026-09-01',NULL),
        ('333333333','ok','2026-09-01',NULL),('999999999','ok','2026-09-01',NULL);
      CREATE TABLE registry_company_history(eik,names_json,source_hash,fetched_at);
      CREATE TABLE declarations(id,person_id,institution,position,declared_year,category TEXT GENERATED ALWAYS AS (NULL) VIRTUAL);
      CREATE TABLE declaration_metadata(declaration_id,declaration_type,declared_on,submitted_on);
      CREATE TABLE declared_interests(declaration_id,entity_raw);
      CREATE TABLE declaration_companies(declaration_id,eik);
      CREATE TABLE bidders(id PRIMARY KEY,eik_normalized,name,ownership_kind);
      CREATE TABLE company_totals(bidder_id,contracts);
      CREATE TABLE contracts(id PRIMARY KEY,bidder_id,tender_id,signed_at,amount_eur);
      CREATE TABLE tenders(id PRIMARY KEY,authority_id);
      INSERT INTO persons VALUES('p','Лице Роля'),('q','Лице Дял'),('r','Лице Без');
      INSERT INTO person_registry_links VALUES('p','${H}'),('q','${'q'.repeat(64)}');
      INSERT INTO interest_links VALUES('q','published','private_ownership','999999999');
      INSERT INTO interest_link_evidence VALUES('q:999999999','document');
      -- The partner role at 111111111 ENDS at the start of 2021, so the 2022 contract falls outside it —
      -- even though 2022 is one of this person's office years. „Стойност в периода" must ask about the
      -- company, not about whether the person held some office that year.
      INSERT INTO registry_roles(subject_id,subject_kind,role,eik,removed_on) VALUES('${H}','person','partner','111111111','2021-01-01');
      INSERT INTO registry_roles(subject_id,subject_kind,role,eik) VALUES('${H}','person','manager','222222222'),
        ('${'q'.repeat(64)}','person','partner','111111111'),('${'q'.repeat(64)}','person','partner','999999999'),
        ('${'r'.repeat(64)}','person','partner','111111111');
      INSERT INTO declarations VALUES('d20','p','Община','Кмет','2020'),('d21','p','Община','','2021'),
        ('d22','p','Община','','2022'),('d18','p','Община','','2018'),('e20','p','Община','Кмет','2020'),
        ('d19','p','','','2019');
      -- 2019 names another company only; 2020 is blank in both its filings, so nothing of that year was
      -- read and it is no finding; 2021 names the company in its own spelling, 2022 is tied to the ЕИК,
      -- 2018 precedes the ownership, and e20 is not an annual declaration.
      INSERT INTO declaration_metadata(declaration_id,declaration_type) VALUES('d20','Annualy'),('d21','Annualy'),('d22','Annualy'),('d18','Annualy'),('e20','Entry'),('d19','Annualy');
      INSERT INTO declared_interests VALUES('d21','„Изпълнител“ ЕООД'),('d19','Друга Фирма ЕООД');
      INSERT INTO declaration_companies VALUES('d22','111111111');
      INSERT INTO bidders VALUES('b1','111111111','Изпълнител',NULL),('b2','222222222','Държавно','state'),
        ('b3','333333333','Частно',NULL),('b9','999999999','Декларирано',NULL);
      INSERT INTO company_totals VALUES('b1',2),('b2',1),('b3',1),('b9',1);
      INSERT INTO registry_roles(subject_id,subject_kind,role,eik) VALUES('${H}','person','manager','333333333');
      INSERT INTO tenders VALUES('t','a'),('t2','other');
      INSERT INTO contracts VALUES('c1','b1','t','2020-05-01',100),('c2','b1','t2','2022-05-01',50),('c3','b2','t','2020-01-01',999),
        ('c4','b3','t','2019-01-01',7),('c9','b9','t','2020-01-01',1000);`);
    const rows = await getRegistryRolePersonRows(d1FromSqlite(db));
    // r is not a declarant the register identifies. q declared a stake in 999999999: that company is in q's
    // declared row, and q is here only with the company the register alone records.
    expect(rows.map((r) => r.official)).toEqual(['Лице Роля', 'Лице Дял']);
    expect(rows[1]).toMatchObject({
      stakeKind: 'registry',
      companyCount: 1,
      contractValueEur: 150,
      companies: [{ eik: '111111111', registryRole: 'owner' }],
    });
    expect(rows[0]).toMatchObject({
      official: 'Лице Роля',
      personIdentity: H,
      stakeKind: 'registry',
      companyCount: 2, // a private company's manager counts; a state enterprise's does not
      contractCount: 3,
      contractValueEur: 157,
      // Only c1 (2020): inside the partner role AND an office year. c2 (2022) is an office year but the
      // role had ended; c4 (2019) is inside an open role but 2019 is no office year. Each of the two
      // halves alone would have counted one of them.
      contemporaneousValueEur: 100,
      hasContemporaneous: true,
      companies: [
        {
          eik: '111111111',
          company: 'Изпълнител',
          self: 0,
          family: 0,
          registry: 1,
          registryRole: 'owner',
          missingYears: ['2019'],
        },
        {
          eik: '333333333',
          company: 'Частно',
          self: 0,
          family: 0,
          registry: 1,
          registryRole: 'manager',
          missingYears: [],
        },
      ],
    });
    expect(await getRegistryRolePersonRows(d1FromSqlite(db), 'other')).toHaveLength(2);
    expect(await getRegistryRolePersonRows(d1FromSqlite(db), 'nobody')).toEqual([]);
  } finally {
    db.close();
  }
});

it('finds a registered company in any filing of the year — another document, a former name, its ЕИК in the text', async () => {
  const db = new DatabaseSync(':memory:');
  const H = 'h'.repeat(64);
  try {
    db.exec(`CREATE TABLE persons(id PRIMARY KEY,name);
      CREATE TABLE person_registry_links(person_id PRIMARY KEY,registry_indent);
      CREATE TABLE interest_links(person_id,status,interest_class,eik,relation,
        link_key TEXT GENERATED ALWAYS AS (person_id || ':' || eik) VIRTUAL);
      CREATE TABLE interest_link_evidence(link_key,evidence_kind);
      CREATE TABLE registry_roles(subject_id,subject_kind,role,eik,added_on DEFAULT '2019-01-01',removed_on,uncertain_after);
      CREATE TABLE registry_deeds(eik,outcome,fetched_at,name);
      CREATE TABLE registry_company_history(eik,names_json,source_hash,fetched_at);
      CREATE TABLE declarations(id,person_id,institution,position,declared_year,category TEXT GENERATED ALWAYS AS (NULL) VIRTUAL);
      CREATE TABLE declaration_metadata(declaration_id,declaration_type,declared_on,submitted_on);
      CREATE TABLE declared_interests(declaration_id,entity_raw);
      CREATE TABLE declaration_companies(declaration_id,eik);
      CREATE TABLE bidders(id PRIMARY KEY,eik_normalized,name,ownership_kind);
      CREATE TABLE company_totals(bidder_id,contracts);
      CREATE TABLE contracts(id PRIMARY KEY,bidder_id,tender_id,signed_at,amount_eur);
      CREATE TABLE tenders(id PRIMARY KEY,authority_id);
      INSERT INTO persons VALUES('p','Лице Тестово');
      INSERT INTO person_registry_links VALUES('p','${H}');
      INSERT INTO registry_roles(subject_id,subject_kind,role,eik) VALUES('${H}','person','partner','111111111'),
        ('${H}','person','partner','222222222'),('${H}','person','partner','333333333'),
        ('${H}','person','partner','444444444');
      INSERT INTO registry_deeds VALUES('111111111','ok','2026-09-01','ПЪРВА'),('222222222','ok','2026-09-01','НОВА МАРКА'),
        ('333333333','ok','2026-09-01','ТРЕТА'),('444444444','ok','2026-09-01','ЧЕТВЪРТА');
      INSERT INTO registry_company_history VALUES('222222222','[{"name":"СТАРА МАРКА","legalForm":"ООД"}]','h','2026-09-01');
      INSERT INTO declarations VALUES('d19','p','','','2019'),('e19','p','','','2019');
      INSERT INTO declaration_metadata(declaration_id,declaration_type) VALUES('d19','Annualy'),('e19','Entry');
      INSERT INTO declared_interests VALUES('d19','Стара марка ООД'),('d19','дружество с ЕИК 333333333'),
        ('d19','Нещо Друго ЕООД'),('e19','ПЪРВА ЕООД');
      INSERT INTO bidders VALUES('b1','111111111','Първа',NULL),('b2','222222222','Нова Марка',NULL),
        ('b3','333333333','Трета',NULL),('b4','444444444','Четвърта',NULL);
      INSERT INTO company_totals VALUES('b1',1),('b2',1),('b3',1),('b4',1);
      INSERT INTO tenders VALUES('t','a');
      INSERT INTO contracts VALUES('c1','b1','t','2020-01-01',1),('c2','b2','t','2020-01-01',1),
        ('c3','b3','t','2020-01-01',1),('c4','b4','t','2020-01-01',1);`);
    const rows = await getRegistryRolePersonRows(d1FromSqlite(db));
    // The entry declaration of the same year names ПЪРВА, the annual one names НОВА МАРКА by its former
    // name and ТРЕТА by its ЕИК; only ЧЕТВЪРТА is nowhere in the year's filings.
    expect(Object.fromEntries(rows[0]!.companies.map((c) => [c.eik, c.missingYears]))).toEqual({
      '111111111': [],
      '222222222': [],
      '333333333': [],
      '444444444': ['2019'],
    });

    // A company the declarations tie to stays in the group — the register records the person there — and the
    // row says what the declarations say about it, instead of dropping it as if it were left out.
    db.exec(`INSERT INTO interest_links VALUES('p','held','private_ownership','444444444','manages'),
      ('p','held','private_ownership','333333333','owns');`);
    const withLinks = await getRegistryRolePersonRows(d1FromSqlite(db));
    expect(Object.fromEntries(withLinks[0]!.companies.map((c) => [c.eik, c.declared]))).toEqual({
      '111111111': null,
      '222222222': null,
      '333333333': 'stake',
      '444444444': 'manages',
    });
    // The same through another declarant record of the same register identity.
    db.exec(`INSERT INTO persons VALUES('p2','Лице Тестово');
      INSERT INTO person_registry_links VALUES('p2','${H}');
      INSERT INTO interest_links VALUES('p2','withdrawn','family_ownership','222222222','related');`);
    const viaIdentity = await getRegistryRolePersonRows(d1FromSqlite(db));
    const row = viaIdentity.find((r) => r.officialSlug === withLinks[0]!.officialSlug)!;
    expect(row.companies.find((c) => c.eik === '222222222')!.declared).toBe('family');
    // The person's office and a tie taken down on an objection leave the group; nothing else does.
    db.exec(`INSERT INTO interest_links VALUES('p','internal','ex_officio_board','111111111','manages'),
      ('p','suppressed','private_ownership','444444444','manages');`);
    const after = (await getRegistryRolePersonRows(d1FromSqlite(db))).find(
      (r) => r.officialSlug === withLinks[0]!.officialSlug,
    )!;
    expect(after.companies.map((c) => c.eik).sort()).toEqual(['222222222', '333333333']);
  } finally {
    db.close();
  }
});

it('names the only company of a single-company declarant, and tells own, family and mixed stakes apart', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE persons(id PRIMARY KEY,name);
      CREATE TABLE interest_links(link_key,person_id,eik,status,interest_class,own_institution,first_declared_year,last_declared_year);
      CREATE TABLE interest_link_evidence(link_key,evidence_kind,matched_fact TEXT GENERATED ALWAYS AS (NULL) VIRTUAL);
      CREATE TABLE interest_link_observations(link_key,declaration_id,kind,timing,reported_year);
      CREATE TABLE person_registry_links(person_id,registry_indent);
      CREATE TABLE declarations(id,person_id,institution,position,declared_year,category TEXT GENERATED ALWAYS AS (NULL) VIRTUAL);
      CREATE TABLE IF NOT EXISTS declaration_metadata(declaration_id,declaration_type,declared_on,submitted_on);
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
      INSERT INTO interest_link_evidence SELECT link_key,'document' FROM interest_links;
      ALTER TABLE interest_links ADD COLUMN relation TEXT;
      UPDATE interest_links SET relation=CASE interest_class WHEN 'family_ownership' THEN 'related' ELSE 'owns' END;
      INSERT INTO persons VALUES('person:manager','Управител');
      INSERT INTO interest_links VALUES('g','person:manager','111111111','published','private_ownership','none','2020','2020','manages');
      INSERT INTO interest_link_evidence VALUES('g','document');`);
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
        { eik: '222222222', company: 'Втора', self: 0, family: 1, manages: 0 },
        { eik: '111111111', company: 'Първа', self: 1, family: 0, manages: 0 },
      ],
    });
    // A private company's manager is listed like an owner, and the company says it is a management.
    expect(by('Управител')).toMatchObject({
      stakeKind: 'self',
      companies: [{ eik: '111111111', company: 'Първа', self: 0, family: 0, manages: 1 }],
    });
  } finally {
    db.close();
  }
});

// ADR-0047 §3 put management of a private company beside a stake, but the query implemented only
// `manager` — the ООД's word for it. A company limited by shares is run by its съвет на директорите or
// управителен съвет, whose members decide whether it bids exactly as an управител does; leaving them out
// showed the manager of a small ООД and hid the board of a large АД. Oversight seats stay out: they
// appoint and check, they do not manage.
it('counts the governing body of a private winner, not the seats that only oversee it', async () => {
  const db = new DatabaseSync(':memory:');
  const indent = 'a'.repeat(64);
  const rolesFor = async (role: string) => {
    db.exec(`DELETE FROM registry_roles;
      INSERT INTO registry_roles(subject_id,subject_kind,role,eik) VALUES('${indent}','person','${role}','333333333');`);
    return await getRegistryRolePersonRows(d1FromSqlite(db));
  };
  try {
    db.exec(`CREATE TABLE persons(id PRIMARY KEY,name);
      CREATE TABLE person_registry_links(person_id PRIMARY KEY,registry_indent);
      CREATE TABLE interest_links(person_id,status,interest_class,eik,relation TEXT GENERATED ALWAYS AS (NULL) VIRTUAL,
        link_key TEXT GENERATED ALWAYS AS (person_id || ':' || eik) VIRTUAL);
      CREATE TABLE interest_link_evidence(link_key,evidence_kind);
      CREATE TABLE registry_roles(subject_id,subject_kind,role,eik,added_on DEFAULT '2019-01-01',removed_on,uncertain_after);
      -- An open role counts only up to the last successful read of the partida.
      CREATE TABLE registry_deeds(eik,outcome,fetched_at,name);
      INSERT INTO registry_deeds VALUES('111111111','ok','2026-09-01',NULL),('222222222','ok','2026-09-01',NULL),
        ('333333333','ok','2026-09-01',NULL);
      CREATE TABLE registry_company_history(eik,names_json,source_hash,fetched_at);
      CREATE TABLE declarations(id,person_id,institution,position,declared_year,category TEXT GENERATED ALWAYS AS (NULL) VIRTUAL);
      CREATE TABLE declaration_metadata(declaration_id,declaration_type,declared_on,submitted_on);
      CREATE TABLE declared_interests(declaration_id,entity_raw);
      CREATE TABLE declaration_companies(declaration_id,eik);
      CREATE TABLE bidders(id PRIMARY KEY,eik_normalized,name,ownership_kind);
      CREATE TABLE company_totals(bidder_id,contracts);
      CREATE TABLE contracts(id PRIMARY KEY,bidder_id,tender_id,signed_at,amount_eur);
      CREATE TABLE tenders(id PRIMARY KEY,authority_id);
      INSERT INTO persons VALUES('p','Лице Роля');
      INSERT INTO person_registry_links VALUES('p','${indent}');
      INSERT INTO declarations VALUES('d20','p','Община','Кмет','2020');
      INSERT INTO declaration_metadata(declaration_id,declaration_type) VALUES('d20','Annualy');
      INSERT INTO bidders VALUES('b3','333333333','Частно',NULL);
      INSERT INTO company_totals VALUES('b3',1);
      INSERT INTO tenders VALUES('t','a');
      INSERT INTO contracts VALUES('c4','b3','t','2020-01-01',7);`);

    const manager = await rolesFor('manager');
    expect(manager).toHaveLength(1);
    expect(manager[0]?.companies?.[0]).toMatchObject({ eik: '333333333', registryRole: 'manager' });
    expect(manager[0]?.direct).toMatchObject({ companyCount: 1, contractValueEur: 7 });
    // A seat on a collegial body is listed, named as such, and has no figures without the seats.
    for (const role of ['board_of_directors', 'management_board', 'governing_body']) {
      const rows = await rolesFor(role);
      expect(rows, role).toHaveLength(1);
      expect(rows[0]?.companies?.[0], role).toMatchObject({
        eik: '333333333',
        registryRole: 'board',
      });
      expect(rows[0]?.direct, role).toBeNull();
    }
    // Ownership in one company and a seat in another: the figures without the seats keep the first only.
    db.exec(`INSERT INTO bidders VALUES('b4','444444444','Собствено',NULL);
      INSERT INTO company_totals VALUES('b4',1);
      INSERT INTO registry_deeds VALUES('444444444','ok','2026-09-01',NULL);
      INSERT INTO contracts VALUES('c5','b4','t','2020-03-01',40);`);
    const mixed = await (async () => {
      db.exec(`DELETE FROM registry_roles;
        INSERT INTO registry_roles(subject_id,subject_kind,role,eik) VALUES
          ('${indent}','person','board_of_directors','333333333'),('${indent}','person','partner','444444444');`);
      return await getRegistryRolePersonRows(d1FromSqlite(db));
    })();
    expect(mixed[0]).toMatchObject({
      companyCount: 2,
      contractValueEur: 47,
      direct: {
        companyCount: 1,
        contractCount: 1,
        contractValueEur: 40,
        contemporaneousValueEur: 40,
        hasContemporaneous: true,
      },
    });
    expect(mixed[0]?.companies?.map((c) => [c.eik, c.registryRole])).toEqual([
      ['444444444', 'owner'],
      ['333333333', 'board'],
    ]);
    for (const role of ['supervisory_board', 'controlling_board', 'procurator', 'branch_manager'])
      expect(await rolesFor(role), role).toEqual([]);
  } finally {
    db.close();
  }
});

it('lists a declared seat on a board only with the seats, and a declared stake or registered manager by default', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE persons(id PRIMARY KEY,name);
      CREATE TABLE interest_links(link_key,person_id,eik,status,interest_class,relation,own_institution,first_declared_year,last_declared_year);
      CREATE TABLE interest_link_evidence(link_key,evidence_kind,matched_fact);
      CREATE TABLE interest_link_observations(link_key,declaration_id,kind,timing,reported_year);
      CREATE TABLE person_registry_links(person_id,registry_indent);
      CREATE TABLE declarations(id,person_id,institution,position,declared_year,category);
      CREATE TABLE declaration_metadata(declaration_id,declaration_type,declared_on,submitted_on);
      CREATE TABLE bidders(id PRIMARY KEY,eik_normalized,name);
      CREATE TABLE contracts(id PRIMARY KEY,bidder_id,tender_id,signed_at,amount_eur);
      CREATE TABLE tenders(id PRIMARY KEY,authority_id);CREATE TABLE authorities(id PRIMARY KEY);
      INSERT INTO authorities VALUES('a');INSERT INTO tenders VALUES('t','a');
      INSERT INTO bidders VALUES('b1','111111111','Борд АД'),('b2','222222222','Дял ООД'),('b3','333333333','Управител ООД');
      INSERT INTO contracts VALUES('c1','b1','t','2020-02-01',100),('c2','b2','t','2020-02-01',20),('c3','b3','t','2020-02-01',3);
      INSERT INTO persons VALUES('pb','Само Съвет Тестов'),('pm','Дял И Съвет'),('pr','Вписан Управител');
      INSERT INTO interest_links VALUES
        ('lb','pb','111111111','published','private_ownership','manages','no','2020','2020'),
        ('ls','pm','222222222','published','private_ownership','owns','no','2020','2020'),
        ('lb2','pm','111111111','published','private_ownership','manages','no','2020','2020'),
        ('lr','pr','333333333','published','private_ownership','manages','no','2020','2020');
      INSERT INTO interest_link_evidence VALUES('lb','document','role:manager:00120'),
        ('ls','document','role:owner:00190'),('lb2','document','role:manager:00125'),
        ('lr','document','role:manager:00070');
      INSERT INTO declarations VALUES('db','pb','Община','Съветник','2020',''),('dm','pm','Община','Съветник','2020',''),
        ('dr','pr','Община','Съветник','2020','');`);
    const rows = await getRelatedPersonRows(d1FromSqlite(db));
    const of = (name: string) => rows.find((r) => r.official === name)!;
    // Only a seat on a board: listed with the seats, with nothing to list by default.
    expect(of('Само Съвет Тестов').direct).toBeNull();
    expect(of('Само Съвет Тестов').companies[0]).toMatchObject({ eik: '111111111', board: 1 });
    // A stake beside a seat: by default the stake alone, with its own figures.
    expect(of('Дял И Съвет').direct).toMatchObject({ companyCount: 1, contractValueEur: 20 });
    expect(of('Дял И Съвет').contractValueEur).toBe(120);
    // A manager the register records as such is listed whole in either view.
    expect('direct' in of('Вписан Управител')).toBe(false);
    expect(of('Вписан Управител').companies[0]).toMatchObject({ eik: '333333333', board: 0 });
  } finally {
    db.close();
  }
});

it('leaves out the organization a person files declarations for as a member of its bodies — for that person only', async () => {
  const [ORG] = OFFICE_ORGANIZATIONS;
  const db = new DatabaseSync(':memory:');
  const member = 'm'.repeat(64);
  const councillor = 'c'.repeat(64);
  try {
    db.exec(`CREATE TABLE persons(id PRIMARY KEY,name);
      CREATE TABLE person_registry_links(person_id PRIMARY KEY,registry_indent);
      CREATE TABLE interest_links(person_id,status,interest_class,eik,relation,
        link_key TEXT GENERATED ALWAYS AS (person_id || ':' || eik) VIRTUAL);
      CREATE TABLE interest_link_evidence(link_key,evidence_kind);
      CREATE TABLE registry_roles(subject_id,subject_kind,role,eik,added_on DEFAULT '2019-01-01',removed_on,uncertain_after);
      CREATE TABLE registry_deeds(eik,outcome,fetched_at,name);
      CREATE TABLE registry_company_history(eik,names_json,source_hash,fetched_at);
      CREATE TABLE declarations(id,person_id,institution,position,declared_year,category);
      CREATE TABLE declaration_metadata(declaration_id,declaration_type,declared_on,submitted_on);
      CREATE TABLE declared_interests(declaration_id,entity_raw);
      CREATE TABLE declaration_companies(declaration_id,eik);
      CREATE TABLE bidders(id PRIMARY KEY,eik_normalized,name,ownership_kind);
      CREATE TABLE company_totals(bidder_id,contracts);
      CREATE TABLE contracts(id PRIMARY KEY,bidder_id,tender_id,signed_at,amount_eur);
      CREATE TABLE tenders(id PRIMARY KEY,authority_id);
      INSERT INTO persons VALUES('pm','Член Тестов Органов'),('pc','Съветник Тестов Общински');
      INSERT INTO person_registry_links VALUES('pm','${member}'),('pc','${councillor}');
      INSERT INTO registry_roles(subject_id,subject_kind,role,eik) VALUES
        ('${member}','person','governing_body','${ORG!.eik}'),('${member}','person','partner','555555555'),
        ('${councillor}','person','governing_body','${ORG!.eik}');
      INSERT INTO registry_deeds VALUES('${ORG!.eik}','ok','2026-09-01',NULL),('555555555','ok','2026-09-01',NULL);
      INSERT INTO declarations VALUES
        ('dm','pm','Национален съвет','Член','2020','Членовете на ръководните и на контролните ${ORG!.categoryIncludes}'),
        ('dc','pc','Община','Съветник','2020','Кметове и общински съветници');
      INSERT INTO bidders VALUES('bo','${ORG!.eik}','Организация',NULL),('b5','555555555','Частно',NULL);
      INSERT INTO company_totals VALUES('bo',1),('b5',1);
      INSERT INTO tenders VALUES('t','a');
      INSERT INTO contracts VALUES('c1','bo','t','2020-01-01',5),('c2','b5','t','2020-01-01',6);`);
    const rows = await getRegistryRolePersonRows(d1FromSqlite(db));
    const of = (name: string) => rows.find((r) => r.official === name)!;
    expect(of('Член Тестов Органов').companies.map((c) => c.eik)).toEqual(['555555555']);
    expect(of('Член Тестов Органов').contractValueEur).toBe(6);
    expect(of('Съветник Тестов Общински').companies.map((c) => c.eik)).toEqual([ORG!.eik]);
  } finally {
    db.close();
  }
});
