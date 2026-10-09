import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { getPersonDeclarations } from './declarations';
import { getPersonSourceArchive } from './person-identity';
it('returns every source and its own role/dates, including a filing with no company interest', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE declarations(id,person_id,declared_year,template,category,institution,position,source_url);
   CREATE TABLE declaration_metadata(declaration_id,declaration_type,declared_on,submitted_on);
   CREATE TABLE declared_interests(declaration_id,entity_key,entity_raw,kind,timing);
   CREATE TABLE interest_link_observations(link_key,declaration_id,kind,timing,reported_year);
   CREATE TABLE person_registry_links(person_id,registry_indent);
   CREATE TABLE bidders(id,name);
   CREATE TABLE interest_links(person_id,entity_key,eik,status,interest_class,link_key,match_method,bidder_id);
   CREATE TABLE interest_link_evidence(link_key,evidence_kind);
   INSERT INTO declarations VALUES('a','p','2020','assets','','Община А','Кмет','https://example.test/a'),('b','p','2022','assets','','Община Б','Съветник','https://example.test/b');
   INSERT INTO declaration_metadata VALUES('a','Annual','2021-01-01','2021-02-01'),('b','Vacate',NULL,NULL);
   INSERT INTO declared_interests VALUES('a','company','Компания','shares','annual');
   INSERT INTO interest_link_observations(link_key,declaration_id,kind,timing) VALUES('l','a','shares','annual');
   INSERT INTO interest_links(person_id,entity_key,eik,status,interest_class,link_key,match_method) VALUES('p','company','111111111','published','private_ownership','l','exact_name_key');
   INSERT INTO interest_link_evidence VALUES('l','document');`);
    const docs = await getPersonDeclarations(d1FromSqlite(db), 'p');
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({
      id: 'b',
      year: '2022',
      institution: 'Община Б',
      position: 'Съветник',
      companyEiks: [],
      submittedOn: null,
    });
    expect(docs[1]).toMatchObject({
      year: '2020',
      declaredOn: '2021-01-01',
      submittedOn: '2021-02-01',
      companyEiks: ['111111111'],
      interests: [
        { company: 'Компания', eik: '111111111', kind: 'shares', timing: 'annual', scope: 'self' },
      ],
    });
    db.exec(
      "CREATE TABLE persons(id,name); INSERT INTO persons VALUES('p','Иван Тестов'); DELETE FROM interest_link_evidence;",
    );
    const archive = await getPersonSourceArchive(d1FromSqlite(db), 'p');
    expect(archive?.name).toBe('Иван Тестов');
    expect(archive?.declarations.map((d) => d.id)).toEqual(['b', 'a']);
    expect(archive?.declarations.every((d) => d.companyEiks.length === 0)).toBe(true);
    expect(await getPersonSourceArchive(d1FromSqlite(db), 'missing')).toBeNull();
  } finally {
    db.close();
  }
});

it('uses resolved EIKs for all sources and never borrows a same-named company or an unsealed claim', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE declarations(id,person_id,declared_year,template,category,institution,position,source_url);
      CREATE TABLE declared_interests(declaration_id,entity_key,entity_raw,kind,timing);
   CREATE TABLE interest_link_observations(link_key,declaration_id,kind,timing,reported_year);
   CREATE TABLE person_registry_links(person_id,registry_indent);
   CREATE TABLE bidders(id,name);
      CREATE TABLE declaration_companies(declaration_id,eik,match_method);
      CREATE TABLE interest_links(person_id,entity_key,eik,status,interest_class,link_key,match_method,bidder_id);
      CREATE TABLE interest_link_evidence(link_key,evidence_kind);
      INSERT INTO declarations VALUES
        ('a','p','2020','assets','','И','П','https://example.test/a'),
        ('b','p','2021','assets','','И','П','https://example.test/b'),
        ('c','p','2022','assets','','И','П','https://example.test/c'),
        ('d','p','2023','assets','','И','П','https://example.test/d');
      INSERT INTO declared_interests VALUES('a','same name','Име','shares','annual'),('b','same name','Име','participation','prior'),('c','prose with EIK','Име с ЕИК','shares','current'),('d','unsealed','Непотвърдено','shares','current');
      INSERT INTO interest_link_observations(link_key,declaration_id,kind,timing) VALUES('l1','a','shares','annual'),('l2','b','participation','prior'),('l1','c','shares','current'),('l3','d','shares','current');
      INSERT INTO declaration_companies VALUES('a','111','declared_eik'),('b','222','declared_eik'),('c','111','extracted_name'),('d','333','exact_name_key');
      INSERT INTO interest_links(person_id,entity_key,eik,status,interest_class,link_key,match_method) VALUES
        ('p','same name','111','published','private_ownership','l1','declared_eik'),
        ('p','same name','222','published','private_ownership','l2','declared_eik'),
        ('p','unsealed','333','published','private_ownership','l3','exact_name_key');
      INSERT INTO interest_link_evidence VALUES('l1','document'),('l2','confirmed');`);
    const docs = await getPersonDeclarations(d1FromSqlite(db), 'p');
    expect(Object.fromEntries(docs.map((d) => [d.id, d.companyEiks]))).toEqual({
      a: ['111'],
      b: ['222'],
      c: ['111'],
      d: [],
    });
    expect(docs.find((d) => d.id === 'a')!.interests).toEqual([
      { company: 'Име', eik: '111', kind: 'shares', timing: 'annual', scope: 'self' },
    ]);
    expect(docs.find((d) => d.id === 'b')!.interests).toEqual([
      { company: 'Име', eik: '222', kind: 'participation', timing: 'prior', scope: 'self' },
    ]);
    expect(docs.find((d) => d.id === 'd')!.interests![0]).toMatchObject({
      eik: null,
      scope: 'unknown',
    });
  } finally {
    db.close();
  }
});

it('explains both conflicting documents without inventing a stake in the empty filing', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE declarations(id,person_id,declared_year,template,category,institution,position,source_url);
      CREATE TABLE declaration_metadata(declaration_id,declaration_type,declared_on,submitted_on);
      INSERT INTO declaration_metadata VALUES('positive','Annualy',NULL,NULL),('empty','Annualy',NULL,NULL),('entry','Entry',NULL,NULL);
      CREATE TABLE declared_interests(declaration_id,entity_key,entity_raw,kind,timing);
      CREATE TABLE interest_link_observations(link_key,declaration_id,kind,timing,reported_year);
      CREATE TABLE interest_links(person_id,entity_key,eik,status,interest_class,link_key,match_method,bidder_id);
      CREATE TABLE interest_link_evidence(link_key,evidence_kind);
      CREATE TABLE person_registry_links(person_id,registry_indent);
      CREATE TABLE bidders(id,name);
      INSERT INTO bidders VALUES('b','Компания');
      INSERT INTO declarations VALUES('positive','p','2023','assets','','И','П','https://example.test/positive'),('empty','p','2023','assets','','И','П','https://example.test/empty');
      INSERT INTO declarations SELECT 'entry',person_id,declared_year,template,category,institution,position,'https://example.test/entry' FROM declarations WHERE id='positive';
      INSERT INTO declared_interests VALUES('entry','company','Компания','shares','annual');
      INSERT INTO interest_link_observations VALUES('l','entry','shares','annual','2023');
      INSERT INTO declared_interests VALUES('positive','company','Компания','shares','annual');
      INSERT INTO interest_links VALUES('p','company','111','published','family_ownership','l','exact_name_key','b');
      INSERT INTO interest_link_evidence VALUES('l','confirmed');
      INSERT INTO interest_link_observations VALUES('l','positive','shares','annual','2023'),('l','empty','shares','not_listed','2023');`);
    const docs = await getPersonDeclarations(d1FromSqlite(db), 'p');
    expect(docs.find((d) => d.id === 'entry')!.discrepancies).toEqual([]); // entry snapshots are not annual corrections
    expect(docs.find((d) => d.id === 'empty')).toMatchObject({
      companyEiks: [],
      interests: [],
      discrepancies: [
        { eik: '111', listed: false, scope: 'family', otherDeclarationIds: ['positive'] },
      ],
    });
    expect(docs.find((d) => d.id === 'positive')).toMatchObject({
      companyEiks: ['111'],
      discrepancies: [{ listed: true, otherDeclarationIds: ['empty'] }],
    });
  } finally {
    db.close();
  }
});

it('notes ownership the register holds at the end of a reporting year that the annual filing does not name', async () => {
  const db = new DatabaseSync(':memory:');
  const H = 'h'.repeat(64);
  try {
    db.exec(`CREATE TABLE declarations(id,person_id,declared_year,template,category,institution,position,source_url);
   CREATE TABLE declaration_metadata(declaration_id,declaration_type,declared_on,submitted_on);
   CREATE TABLE declared_interests(declaration_id,entity_key,entity_raw,kind,timing);
   CREATE TABLE interest_link_observations(link_key,declaration_id,kind,timing,reported_year);
   CREATE TABLE person_registry_links(person_id,registry_indent);
   CREATE TABLE bidders(id,name);
   CREATE TABLE interest_links(person_id,entity_key,eik,status,interest_class,link_key,match_method,bidder_id);
   CREATE TABLE interest_link_evidence(link_key,evidence_kind);
   CREATE TABLE declaration_companies(declaration_id,eik,match_method);
   CREATE TABLE person_entities(id,registry_indent,created_at);
   CREATE TABLE registry_deeds(eik,name,legal_form);
   CREATE TABLE registry_roles(eik,subject_id,subject_kind,role,entry_number,added_on,removed_on,uncertain_after);
   INSERT INTO declarations VALUES('a','p','2020','assets','','Община А','Кмет','u/a'),('b','p','2021','assets','','Община А','Кмет','u/b'),('c','p','2022','assets','','Община А','Кмет','u/c'),('d','p','2023','assets','','Община А','Кмет','u/d');
   INSERT INTO declaration_metadata VALUES('a','Annual',NULL,NULL),('b','Annual',NULL,NULL),('c','Entry',NULL,NULL),('d','Annual',NULL,NULL);
   INSERT INTO declared_interests VALUES('b','gama','"ГАМА" ЕООД','shares','annual'),
     ('d','alfa-a','АЛФА-А ООД','shares','annual'),('d','gama','Гамма ЕООД','shares','annual'),
     ('d','epsilon','Епсилон Инжинеринг ЕООД','shares','annual');
   INSERT INTO person_entities VALUES('p','${H}','2026-01-01');
   INSERT INTO registry_deeds VALUES('111111111','АЛФА','OOD'),('222222222','ГАМА','EOOD'),('333333333','ДЕЛТА','AD'),('444444444','ЕПСИЛОН ИНЖЕНЕРИНГ','EOOD');
   INSERT INTO registry_roles VALUES
     ('111111111','${H}','person','partner','e1','2019-05-01',NULL,NULL),
     ('222222222','${H}','person','sole_owner','e2','2021-03-01',NULL,NULL),
     ('333333333','${H}','person','board_of_directors','e3','2019-01-01',NULL,NULL),
     ('111111111','${H}','person','manager','e1','2019-05-01',NULL,NULL),
     ('444444444','${H}','person','sole_owner','e4','2022-02-01',NULL,NULL);
   INSERT INTO declaration_companies VALUES('a','111111111','eik');`);
    const docs = await getPersonDeclarations(d1FromSqlite(db), 'p');
    const byId = Object.fromEntries(docs.map((d) => [d.id, d.registryOmissions]));
    // 2020: АЛФА is named (resolved ЕИК); ГАМА not owned yet; the board seat never counts.
    expect(byId.a).toEqual([]);
    // 2021: АЛФА is owned and unnamed (the note spells the form the register keeps as a code) — but the
    // 2020 filing named it, and the note says so; ГАМА is named by spelling only, so it is not an omission.
    expect(byId.b).toEqual([
      {
        eik: '111111111',
        company: 'АЛФА ООД',
        role: 'partner',
        entryNumber: 'e1',
        addedOn: '2019-05-01',
        earlierYear: '2020',
      },
    ]);
    // An entry declaration is not an annual account of the year.
    expect(byId.c).toEqual([]);
    // 2023: a typo in a long name (Инжинеринг) still names the company, and АЛФА-А contains АЛФА whole, so
    // no note claims АЛФА is missing — a note may only stand where nothing resembles the company. One letter
    // is the whole difference between two short names (Гамма is not ГАМА), so ГАМА stays unnamed, with the
    // 2021 filing that did name it.
    expect(byId.d!.map((o) => [o.company, o.earlierYear])).toEqual([['ГАМА ЕООД', '2021']]);
  } finally {
    db.close();
  }
});

it('looks for the company in every filing of the year, by its ЕИК and by any name the register gives it', async () => {
  const db = new DatabaseSync(':memory:');
  const H = 'h'.repeat(64);
  try {
    db.exec(`CREATE TABLE declarations(id,person_id,declared_year,template,category,institution,position,source_url);
   CREATE TABLE declaration_metadata(declaration_id,declaration_type,declared_on,submitted_on);
   CREATE TABLE declared_interests(declaration_id,entity_key,entity_raw,kind,timing);
   CREATE TABLE interest_link_observations(link_key,declaration_id,kind,timing,reported_year);
   CREATE TABLE person_registry_links(person_id,registry_indent);
   CREATE TABLE bidders(id,name);
   CREATE TABLE interest_links(person_id,entity_key,eik,status,interest_class,link_key,match_method,bidder_id);
   CREATE TABLE interest_link_evidence(link_key,evidence_kind);
   CREATE TABLE declaration_companies(declaration_id,eik,match_method);
   CREATE TABLE person_entities(id,registry_indent,created_at);
   CREATE TABLE registry_deeds(eik,name,legal_form);
   CREATE TABLE registry_roles(eik,subject_id,subject_kind,role,entry_number,added_on,removed_on,uncertain_after);
   CREATE TABLE registry_company_history(eik,names_json,source_hash,fetched_at);
   INSERT INTO declarations VALUES('a22','p','2022','assets','','Община Тест','Кмет','u/1'),
     ('c22','p','2022','assets','','Община Тест','Кмет','u/2'),('a23','p','2023','assets','','Община Тест','Кмет','u/3'),
     ('a24','p','2024','assets','','Община Тест','Кмет','u/4');
   INSERT INTO declaration_metadata VALUES('a22','Annualy',NULL,NULL),('c22','Change',NULL,NULL),
     ('a23','Annualy',NULL,NULL),('a24','Annualy',NULL,NULL);
   -- 2022: the annual names РОТА by its ЕИК and СИГНА by its former name; the change filing names КАППА.
   -- 2023: nothing was read from the filing. 2024: only another company is named.
   INSERT INTO declared_interests VALUES('a22','x','Дружество с ЕИК 111 111 111','shares','annual'),
     ('a22','y','Старо Име ООД','shares','annual'),('c22','z','"Каппа" ЕАД','shares','annual'),
     ('a24','w','Друго Тестово ООД','shares','annual');
   INSERT INTO person_entities VALUES('p','${H}','2026-01-01');
   INSERT INTO registry_deeds VALUES('111111111','РОТА','OOD'),('222222222','СИГНА','OOD'),('333333333','КАППА','EAD');
   INSERT INTO registry_company_history VALUES('222222222','[{"name":"СТАРО ИМЕ","legalForm":"ООД"},{"name":"СИГНА","legalForm":"ООД"}]','h','2026-09-01');
   INSERT INTO registry_roles VALUES
     ('111111111','${H}','person','partner','e1','2020-01-01',NULL,NULL),
     ('222222222','${H}','person','partner','e2','2020-01-01',NULL,NULL),
     ('333333333','${H}','person','sole_owner','e3','2020-01-01',NULL,NULL);`);
    const docs = await getPersonDeclarations(d1FromSqlite(db), 'p');
    const byId = Object.fromEntries(docs.map((d) => [d.id, d.registryOmissions]));
    // 2022: every company is named somewhere in that year's filings.
    expect(byId.a22).toEqual([]);
    // 2023: nothing was read from the filing — it may be blank or unread, so no note at all.
    expect(byId.a23).toEqual([]);
    // 2024: none of the three is named; each was named in 2022, and the note says so.
    expect(byId.a24!.map((o) => [o.eik, o.earlierYear])).toEqual([
      ['111111111', '2022'],
      ['222222222', '2022'],
      ['333333333', '2022'],
    ]);
  } finally {
    db.close();
  }
});

it('compares by the entries alone when the resolver and the register history are not there', async () => {
  const db = new DatabaseSync(':memory:');
  const H = 'h'.repeat(64);
  try {
    db.exec(`CREATE TABLE declarations(id,person_id,declared_year,template,category,institution,position,source_url);
   CREATE TABLE declaration_metadata(declaration_id,declaration_type,declared_on,submitted_on);
   CREATE TABLE declared_interests(declaration_id,entity_key,entity_raw,kind,timing);
   CREATE TABLE interest_link_observations(link_key,declaration_id,kind,timing,reported_year);
   CREATE TABLE person_registry_links(person_id,registry_indent);
   CREATE TABLE bidders(id,name);
   CREATE TABLE interest_links(person_id,entity_key,eik,status,interest_class,link_key,match_method,bidder_id);
   CREATE TABLE interest_link_evidence(link_key,evidence_kind);
   CREATE TABLE person_entities(id,registry_indent,created_at);
   CREATE TABLE registry_deeds(eik,name,legal_form);
   CREATE TABLE registry_roles(eik,subject_id,subject_kind,role,entry_number,added_on,removed_on,uncertain_after);
   INSERT INTO declarations VALUES('a24','p','2024','assets','','Община Тест','Кмет','u/4');
   INSERT INTO declaration_metadata VALUES('a24','Annualy',NULL,NULL);
   INSERT INTO declared_interests VALUES('a24','w','Друго Тестово ООД','shares','annual');
   INSERT INTO person_entities VALUES('p','${H}','2026-01-01');
   INSERT INTO registry_deeds VALUES('111111111','РОТА','OOD');
   INSERT INTO registry_roles VALUES('111111111','${H}','person','partner','e1','2020-01-01',NULL,NULL);`);
    const docs = await getPersonDeclarations(d1FromSqlite(db), 'p');
    expect(docs[0]!.registryOmissions).toEqual([
      {
        eik: '111111111',
        company: 'РОТА ООД',
        role: 'partner',
        entryNumber: 'e1',
        addedOn: '2020-01-01',
      },
    ]);
  } finally {
    db.close();
  }
});

it('fails loudly when the declarations themselves are missing, not only an optional table', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE declaration_metadata(declaration_id,declaration_type,declared_on,submitted_on);
      CREATE TABLE declaration_companies(declaration_id,eik,match_method);
      CREATE TABLE declared_interests(declaration_id,entity_key,entity_raw,kind,timing);
      CREATE TABLE interest_link_observations(link_key,declaration_id,kind,timing,reported_year);
      CREATE TABLE interest_links(person_id,entity_key,eik,status,interest_class,link_key,match_method,bidder_id);
      CREATE TABLE interest_link_evidence(link_key,evidence_kind);
      CREATE TABLE person_registry_links(person_id,registry_indent);
      CREATE TABLE bidders(id,name);`);
    await expect(getPersonDeclarations(d1FromSqlite(db), 'p')).rejects.toThrow(
      /no such table: declarations/,
    );
  } finally {
    db.close();
  }
});
