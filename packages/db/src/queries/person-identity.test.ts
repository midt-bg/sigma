import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { d1FromSqlite } from '@sigma/test-support';
import { getPersonRelatives, getPersonNamedBy, getPersonName } from './person-identity';
import {
  getPersonDestinations,
  getPersonScope,
  getPersonSourceArchive,
  getPersonSourceNames,
} from './person-identity';

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
      // Bridged without a published stake: the declarant still belongs to the identity's page.
      expect(await getPersonScope(d1, { officialId: 'quiet' })).toEqual({
        indent: 'withheld',
        officialIds: ['quiet'],
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

describe('getPersonSourceNames', () => {
  it('returns the active declaration names for every source in the profile', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE person_sources(id,name,active,namespace,entity_id,legacy_person_id);
        INSERT INTO person_sources VALUES
          ('current','Иван Петров Тестов',1,'cacbg','person-a','legacy-a'),
          ('legacy','Иван Петров Тестов — архив',1,'cacbg',NULL,'person-b'),
          ('inactive','Неактивно Име Тестово',0,'cacbg','person-a',NULL),
          ('foreign','Чуждо Име Тестово',1,'other','person-a',NULL);`);
      const d1 = d1FromSqlite(db);

      expect(await getPersonSourceNames(d1, [])).toEqual([]);
      expect(await getPersonSourceNames(d1, ['person-a', 'person-b'])).toEqual([
        'Иван Петров Тестов',
        'Иван Петров Тестов — архив',
      ]);
    } finally {
      db.close();
    }
  });
});

describe('relatives the register confirms', () => {
  it('names each relative once per company and links only those with a page here, both ways', async () => {
    const db = new DatabaseSync(':memory:');
    const H = 'h'.repeat(64);
    try {
      db.exec(`CREATE TABLE persons(id PRIMARY KEY,name);
        CREATE TABLE person_relatives(person_id,relative_indent,eik,relative_name);
        CREATE TABLE bidders(id,eik_normalized,name);
        CREATE TABLE company_totals(bidder_id,contracts);
        CREATE TABLE registry_roles(eik,subject_id,subject_kind,role,removed_on);
        CREATE TABLE registry_deeds(eik,name,legal_form);
        CREATE TABLE interest_links(link_key,person_id,eik,interest_class);
        CREATE TABLE interest_link_observations(link_key,reported_year);
        INSERT INTO interest_links VALUES('p|111|family','p','111','family_ownership'),('p|222','p','222','private_ownership');
        INSERT INTO interest_link_observations VALUES('p|111|family','2021'),('p|111|family','2020'),('p|111|family',NULL),('p|222','2019');
        INSERT INTO registry_deeds VALUES('222','БЕТА','EOOD');
        INSERT INTO persons VALUES('p','Иван Петров'),('q','Георги Иванов');
        INSERT INTO person_relatives VALUES('p','${H}','111','Мария Петрова'),('q','${H}','111','Мария Петрова'),('p','${'z'.repeat(64)}','222','Зоя Иванова'),('p','${'y'.repeat(64)}','333','Тестова Роднина');
        INSERT INTO bidders VALUES('eik:111','111','АЛФА');
        INSERT INTO company_totals VALUES('eik:111',3);
        INSERT INTO registry_roles VALUES('111','${H}','person','partner',NULL),('111','${H}','person','partner','2019-01-01'),
          ('111','${H}','person','manager','2018-01-01'),('111','${H}','person','beneficial_owner',NULL);`);
      const d1 = d1FromSqlite(db);
      expect(await getPersonRelatives(d1, ['p'])).toEqual([
        {
          name: 'Зоя Иванова',
          indent: 'z'.repeat(64),
          company: { name: 'БЕТА ЕООД', eik: '222' },
          href: null,
          roles: [],
          years: [],
        },
        {
          name: 'Мария Петрова',
          indent: H,
          company: { name: 'АЛФА', eik: '111' },
          href: `/persons/${H}`,
          roles: [
            { role: 'manager', ended: true },
            { role: 'partner', ended: false },
          ],
          years: ['2020', '2021'],
        },
        {
          name: 'Тестова Роднина',
          indent: 'y'.repeat(64),
          company: { name: '333', eik: '333' },
          href: null,
          roles: [],
          years: [],
        },
      ]);
      expect(await getPersonRelatives(d1, [])).toEqual([]);
      expect(
        (await getPersonNamedBy(d1, H)).map((n) => [n.official, n.href, n.company.eik]),
      ).toEqual([
        [
          'Георги Иванов',
          `/persons/${'q'}`.replace(
            '/persons/q',
            '/persons/' + Buffer.from('q').toString('base64url'),
          ),
          '111',
        ],
        ['Иван Петров', '/persons/' + Buffer.from('p').toString('base64url'), '111'],
      ]);
    } finally {
      db.close();
    }
  });
});

// The name is what a profile with no registry entry and no published link has left to show, so the
// lookup has to answer for a person it does not find rather than throw on the way to the page.
describe('getPersonName', () => {
  it('returns the filed name, and null for an id the table does not hold', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE persons(id,name);
        INSERT INTO persons VALUES('p','ИВАН ТЕСТОВ');`);
      expect(await getPersonName(d1FromSqlite(db), 'p')).toBe('ИВАН ТЕСТОВ');
      expect(await getPersonName(d1FromSqlite(db), 'missing')).toBeNull();
    } finally {
      db.close();
    }
  });
});
