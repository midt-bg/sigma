import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { getPersonDestinations, getPersonScope, getPersonSourceArchive } from './person-identity';

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

describe('getPersonScope', () => {
  it('scopes a person by the register identity, and a declarant without one by itself', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE person_registry_links(person_id,registry_indent);
        CREATE TABLE interest_links(person_id,link_key,status,interest_class);
        CREATE TABLE interest_link_evidence(link_key,evidence_kind);
        INSERT INTO person_registry_links VALUES('official','indent'),('alias','indent'),('quiet','withheld');
        INSERT INTO interest_links VALUES('official','l','published','private_ownership'),('quiet','q','held','private_ownership');
        INSERT INTO interest_link_evidence VALUES('l','document'),('q','document');`);
      const d1 = d1FromSqlite(db);
      const identified = { indent: 'indent', officialIds: ['alias', 'official'] };
      expect(await getPersonScope(d1, { indent: 'indent' })).toEqual(identified);
      // An old declarant URL reaches the same scope through the bridge.
      expect(await getPersonScope(d1, { officialId: 'alias' })).toEqual(identified);
      // Bridged, but nothing surfaces under that identity: no declarant is brought into the scope.
      expect(await getPersonScope(d1, { officialId: 'quiet' })).toEqual({
        indent: 'withheld',
        officialIds: [],
      });
      expect(await getPersonScope(d1, { officialId: 'loner' })).toEqual({
        indent: null,
        officialIds: ['loner'],
      });
      expect(await getPersonScope(d1, {})).toEqual({ indent: null, officialIds: [] });
    } finally {
      db.close();
    }
  });
});

describe('getPersonDestinations before the identity migration', () => {
  it('has no destinations while the source tables are missing, and rethrows a missing core table', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE persons(id,name); CREATE TABLE declarations(person_id,institution);');
      expect(await getPersonDestinations(d1FromSqlite(db), 'old')).toEqual([]);
      db.exec(`CREATE TABLE person_source_aliases(alias_id,source_id);
        CREATE TABLE person_sources(id,active,namespace,entity_id,legacy_person_id);
        DROP TABLE declarations;`);
      await expect(getPersonDestinations(d1FromSqlite(db), 'old')).rejects.toThrow(
        /no such table: declarations/,
      );
    } finally {
      db.close();
    }
  });
});

describe('getPersonSourceArchive', () => {
  it('has no archive for a known person without a single source document', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE persons(id,name);
        CREATE TABLE declarations(id,person_id,declared_year,template,category,institution,position,source_url);
        CREATE TABLE declaration_metadata(declaration_id,declaration_type,declared_on,submitted_on);
        CREATE TABLE declaration_companies(declaration_id,eik,match_method);
        CREATE TABLE declared_interests(declaration_id,entity_key,entity_raw,kind,timing);
        CREATE TABLE interest_link_observations(link_key,declaration_id,kind,timing,reported_year);
        CREATE TABLE interest_links(person_id,entity_key,eik,status,interest_class,link_key,match_method,bidder_id);
        CREATE TABLE interest_link_evidence(link_key,evidence_kind);
        CREATE TABLE person_registry_links(person_id,registry_indent);
        CREATE TABLE bidders(id,name);
        INSERT INTO persons VALUES('p','Иван Тестов');`);
      expect(await getPersonSourceArchive(d1FromSqlite(db), 'p')).toBeNull();
    } finally {
      db.close();
    }
  });
});
