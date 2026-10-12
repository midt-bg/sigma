import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { getRelatedPersonRows } from './related-people-list';
import { getAuthorityConflictSummary } from './related-persons';

// The institution profile's declared-stake figure links to /conflicts?authority=; both must count the same
// winners. Real SQL over a small invented corpus, the per-body breakdown stored by an earlier run included.
it("counts the winners the list it links to shows, a winner first paid since the last run's breakdown too", async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE persons(id PRIMARY KEY,name);
      CREATE TABLE interest_links(link_key,person_id,eik,status,interest_class,own_institution,first_declared_year,last_declared_year,relation);
      CREATE TABLE interest_link_evidence(link_key,evidence_kind,matched_fact TEXT GENERATED ALWAYS AS (NULL) VIRTUAL);
      CREATE TABLE interest_link_authorities(link_key,authority_id,own);
      CREATE TABLE interest_link_observations(link_key,declaration_id,kind,timing,reported_year);
      CREATE TABLE person_registry_links(person_id,registry_indent);
      CREATE TABLE declarations(id,person_id,institution,position,declared_year,category TEXT GENERATED ALWAYS AS (NULL) VIRTUAL);
      CREATE TABLE IF NOT EXISTS declaration_metadata(declaration_id,declaration_type,declared_on,submitted_on);
      CREATE TABLE bidders(id PRIMARY KEY,eik_normalized,name);
      CREATE TABLE contracts(id PRIMARY KEY,bidder_id,tender_id,signed_at,amount_eur);
      CREATE TABLE tenders(id PRIMARY KEY,authority_id);
      CREATE TABLE authorities(id PRIMARY KEY);
      INSERT INTO authorities VALUES('auth:a'),('auth:b');
      INSERT INTO tenders VALUES('t-a','auth:a'),('t-b','auth:b');
      INSERT INTO bidders VALUES('w1','111111111','ТЕСТ ЕДНО ЕООД'),('w2','222222222','ТЕСТ ДВЕ ЕООД'),
        ('w3','333333333','ТЕСТ ТРИ ЕООД');
      -- w1 and w2 are paid by А; w2's contract came after the stored breakdown; w3 is paid by Б only.
      INSERT INTO contracts VALUES('c1','w1','t-a','2023-01-01',100),('c2','w2','t-a','2025-06-01',200),
        ('c3','w3','t-b','2023-01-01',300);
      INSERT INTO persons VALUES('p1','Иван Тестов Петров'),('p2','Мария Тестова Иванова'),
        ('p3','Петър Тестов Георгиев');
      INSERT INTO interest_links VALUES
        ('l1','p1','111111111','published','private_ownership','exact','2022','2024','owns'),
        ('l1f','p1','111111111','published','family_ownership','none','2022','2024','related'),
        ('l2','p2','222222222','published','private_ownership','none','2022','2025','owns'),
        ('l3','p3','333333333','published','private_ownership','none','2022','2024','owns');
      INSERT INTO interest_link_evidence VALUES('l1','document'),('l1f','document'),('l2','document'),
        ('l3','document');
      -- What the last run stored for А: only w1, by an official of А itself.
      INSERT INTO interest_link_authorities VALUES('l1','auth:a','exact'),('l3','auth:b','none');
      INSERT INTO declarations VALUES('d1','p1','Тестова институция','Съветник','2023'),
        ('d2','p2','Тестова институция','Съветник','2025'),('d3','p3','Друга институция','Съветник','2023');`);
    const d1 = d1FromSqlite(db);

    const rows = await getRelatedPersonRows(d1, 'auth:a');
    const listed = new Set(rows.flatMap((r) => r.companies.map((c) => c.eik)));
    expect([...listed].sort()).toEqual(['111111111', '222222222']);

    // Two winners, as the list shows — not the one the stored breakdown still knows — and one of them
    // declared by an official of А itself.
    expect(await getAuthorityConflictSummary(d1, 'auth:a')).toEqual({
      companies: listed.size,
      ownCompanies: 1,
    });
    expect(await getAuthorityConflictSummary(d1, 'auth:b')).toEqual({
      companies: 1,
      ownCompanies: 0,
    });
  } finally {
    db.close();
  }
});
