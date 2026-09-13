import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { getPersonDeclarations } from './declarations';
it('returns every source and its own role/dates, including a filing with no company interest', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE declarations(id,person_id,declared_year,template,category,institution,position,source_url);
   CREATE TABLE declaration_metadata(declaration_id,declaration_type,declared_on,submitted_on);
   CREATE TABLE declared_interests(declaration_id,entity_key,entity_raw,kind,timing);
   CREATE TABLE interest_link_observations(link_key,declaration_id,kind,timing);
   CREATE TABLE interest_links(person_id,entity_key,eik,status,interest_class,link_key,match_method);
   CREATE TABLE interest_link_evidence(link_key,evidence_kind);
   INSERT INTO declarations VALUES('a','p','2020','assets','','Община А','Кмет','https://example.test/a'),('b','p','2022','assets','','Община Б','Съветник','https://example.test/b');
   INSERT INTO declaration_metadata VALUES('a','Annual','2021-01-01','2021-02-01'),('b','Vacate',NULL,NULL);
   INSERT INTO declared_interests VALUES('a','company','Компания','shares','annual');
   INSERT INTO interest_link_observations VALUES('l','a','shares','annual');
   INSERT INTO interest_links VALUES('p','company','111111111','published','private_ownership','l','exact_name_key');
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
  } finally {
    db.close();
  }
});

it('uses resolved EIKs for all sources and never borrows a same-named company or an unsealed claim', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE declarations(id,person_id,declared_year,template,category,institution,position,source_url);
      CREATE TABLE declared_interests(declaration_id,entity_key,entity_raw,kind,timing);
   CREATE TABLE interest_link_observations(link_key,declaration_id,kind,timing);
      CREATE TABLE declaration_companies(declaration_id,eik,match_method);
      CREATE TABLE interest_links(person_id,entity_key,eik,status,interest_class,link_key,match_method);
      CREATE TABLE interest_link_evidence(link_key,evidence_kind);
      INSERT INTO declarations VALUES
        ('a','p','2020','assets','','И','П','https://example.test/a'),
        ('b','p','2021','assets','','И','П','https://example.test/b'),
        ('c','p','2022','assets','','И','П','https://example.test/c'),
        ('d','p','2023','assets','','И','П','https://example.test/d');
      INSERT INTO declared_interests VALUES('a','same name','Име','shares','annual'),('b','same name','Име','participation','prior'),('c','prose with EIK','Име с ЕИК','shares','current'),('d','unsealed','Непотвърдено','shares','current');
      INSERT INTO interest_link_observations VALUES('l1','a','shares','annual'),('l2','b','participation','prior'),('l1','c','shares','current'),('l3','d','shares','current');
      INSERT INTO declaration_companies VALUES('a','111','declared_eik'),('b','222','declared_eik'),('c','111','extracted_name'),('d','333','exact_name_key');
      INSERT INTO interest_links VALUES
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
