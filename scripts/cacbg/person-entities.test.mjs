import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  rebuildPersonEntities,
  identityComponents,
  declarationSourceId,
} from './person-entities.mjs';
import { registryIdentityResolver } from './registry-identity.mjs';
import { buildPersonRegistryLinks } from './person-registry-links.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE registry_roles(eik);CREATE TABLE persons(id TEXT PRIMARY KEY,name);CREATE TABLE declarations(id TEXT PRIMARY KEY);
 CREATE TABLE registry_deeds(eik,name,legal_form,seat_settlement,outcome);
 INSERT INTO registry_deeds VALUES('123456789','ТЕСТ ИНФОРМАЦИЯ','OOD','София','ok');`);
  for (const file of ['0014_person_profile.sql', '0017_registry_identity_observations.sql'])
    db.exec(
      fs.readFileSync(new URL('../../packages/db/migrations/' + file, import.meta.url), 'utf8'),
    );
  const a = 'a'.repeat(64),
    b = 'b'.repeat(64),
    name = 'Ивана Петрова Тестова',
    alias = 'Ивана Петрова Примерова';
  const add = (id, n, entry = '20190101120000', field = '00190', kind = 'person') =>
    db
      .prepare('INSERT INTO registry_identity_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        '123456789',
        '1',
        field,
        entry,
        '2019-01-01',
        0,
        id,
        'EGN',
        n,
        n,
        kind,
        'f'.repeat(64),
        '2026-01-01',
      );
  add(a, name);
  add(a, alias, '20200101120000');
  const filing = (xml, person = name) => {
    const doc = {
      declarant: person,
      interests: [
        { entity: 'Тест информация ООД', kind: 'shares', holderRelation: 'self', seat: 'София' },
      ],
    };
    return {
      folder: '2025',
      xmlFile: xml,
      person,
      sourceHash: 'e'.repeat(64),
      identityEvidence: registryIdentityResolver(db)(doc, [person]).evidence,
    };
  };
  return { db, a, b, name, alias, add, filing };
}
const legacy = (f) => 'person:legacy|' + f.person;
test('historical aliases merge documents across institutions and leave an unproved namesake separate', () => {
  const { db, filing, alias, a } = fixture();
  try {
    const x = filing('1.xml'),
      y = filing('2.xml', alias),
      z = { ...filing('3.xml'), identityEvidence: [] };
    const r = rebuildPersonEntities(db, db, [x, y, z], legacy);
    assert.equal(
      r.assignments.get(declarationSourceId(x)),
      r.assignments.get(declarationSourceId(y)),
    );
    assert.equal(r.assignments.get(declarationSourceId(z)), legacy(z));
    assert.equal(r.stats.resolved, 2);
    const id = r.assignments.get(declarationSourceId(x));
    db.prepare('INSERT INTO persons VALUES(?,?)').run(id, x.person);
    buildPersonRegistryLinks(db);
    assert.equal(
      db.prepare('SELECT registry_indent FROM person_registry_links').get().registry_indent,
      a,
    );
    const again = rebuildPersonEntities(db, db, [y, z, x], legacy);
    assert.equal(again.assignments.get(declarationSourceId(x)), id);
  } finally {
    db.close();
  }
});
test('corrected source revokes evidence and splits a previous entity without donating its identity', () => {
  const { db, filing, alias, b } = fixture();
  try {
    const x = filing('1.xml'),
      y = filing('2.xml', alias);
    const before = rebuildPersonEntities(db, db, [x, y], legacy);
    const id = before.assignments.get(declarationSourceId(x));
    db.prepare(
      'UPDATE registry_identity_observations SET registry_indent=?,source_hash=? WHERE name=?',
    ).run(b, 'd'.repeat(64), alias);
    const after = rebuildPersonEntities(db, db, [filing('1.xml'), filing('2.xml', alias)], legacy);
    assert.equal(after.assignments.get(declarationSourceId(x)), id);
    assert.notEqual(after.assignments.get(declarationSourceId(y)), id);
    assert.equal(after.stats.revoked, 1);
    assert.equal(
      db
        .prepare(
          "SELECT count(DISTINCT s.entity_id) n FROM person_source_aliases a JOIN person_sources s ON s.id=a.source_id WHERE a.alias_id=? AND s.namespace='cacbg'",
        )
        .get(id).n,
      2,
    );
  } finally {
    db.close();
  }
});
test('same-name different Indents stay ambiguous; collective holder never becomes proof', () => {
  const { db, filing, add, b, name, alias } = fixture();
  try {
    add(b, name, '20220101120000');
    const x = filing('1.xml');
    const good = filing('verified.xml', alias);
    const r = rebuildPersonEntities(db, db, [x, good], legacy);
    assert.equal(r.assignments.get(declarationSourceId(x)), legacy(x));
    assert.notEqual(r.assignments.get(declarationSourceId(good)), legacy(good));
    assert.equal(r.stats.conflicts, 1);
    db.exec('DELETE FROM registry_identity_observations');
    add(b, name + ' и Георги Петров Примеров', '20220101120000', '00190', 'collective');
    assert.deepEqual(filing('1.xml').identityEvidence, []);
  } finally {
    db.close();
  }
});
test('identity from a direct beneficial-owner observation does not manufacture a public registry role', () => {
  const { db, filing, add, a, name } = fixture();
  try {
    db.exec('DELETE FROM registry_identity_observations');
    add(a, name, '20220101120000', '05500');
    const x = filing('1.xml');
    assert.equal(rebuildPersonEntities(db, db, [x], legacy).stats.resolved, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM registry_roles').get().n, 0);
  } finally {
    db.close();
  }
});
test('exact observation hash and holder locator are revalidated before assignment', () => {
  const { db, filing } = fixture();
  try {
    const x = filing('1.xml');
    x.identityEvidence[0].observation.holderIndex = 9;
    assert.throws(() => rebuildPersonEntities(db, db, [x], legacy), /no longer matches/);
  } finally {
    db.close();
  }
});
test('a reviewed external identity connects only its scoped sources and an explicit difference blocks the component', () => {
  const sources = ['one', 'two', 'professional'].map((id) => ({
    id,
    namespace: 'source',
    source_hash: id,
  }));
  const edge = (l, r, relation = 'same') => ({
    left_source: l,
    right_source: r,
    left_hash: l,
    right_hash: r,
    decision: 'accepted',
    relation,
  });
  const same = [edge('one', 'professional'), edge('two', 'professional')];
  assert.equal(identityComponents(sources, same).length, 1);
  assert.equal(identityComponents(sources, [...same, edge('one', 'two', 'different')]).length, 3);
  assert.equal(
    identityComponents(sources, [{ ...same[0], decision: 'candidate' }, same[1]]).length,
    2,
  );
  assert.equal(identityComponents(sources, [{ ...same[0], left_hash: 'old' }, same[1]]).length, 2);
});
