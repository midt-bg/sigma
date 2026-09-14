import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { getPersonDestinations } from './person-identity';

it('keeps unresolved source archives alongside a proven profile when an old URL splits', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE persons(id,name);
      CREATE TABLE declarations(person_id,institution);
      CREATE TABLE person_source_aliases(alias_id,source_id);
      CREATE TABLE person_sources(id,active,namespace,entity_id,legacy_person_id);
      INSERT INTO persons VALUES('canonical','Иван Тестов'),('source','ИВАН ТЕСТОВ');
      INSERT INTO declarations VALUES('canonical','Първа институция'),('source','Втора институция');
      INSERT INTO person_sources VALUES('a',1,'cacbg','canonical','old'),('b',1,'cacbg',NULL,'source'),('c',0,'cacbg',NULL,'retired');
      INSERT INTO person_source_aliases VALUES('old','a'),('old','b'),('old','c');`);
    const destinations = await getPersonDestinations(d1FromSqlite(db), 'old');
    expect(destinations.map((p) => p.id).sort()).toEqual(['canonical', 'source']);
    expect(destinations.find((p) => p.id === 'source')).toMatchObject({
      kind: 'source',
      declaration_count: 1,
      institutions: 'Втора институция',
    });
    expect(destinations.find((p) => p.id === 'canonical')).toMatchObject({
      kind: 'person',
      declaration_count: 1,
    });
  } finally {
    db.close();
  }
});
