import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparePersons, personSnapshot } from './person-changes.mjs';
import { DatabaseSync } from 'node:sqlite';
const snap = (sources, links = [], offices = []) => ({
  sources: sources.map(([id, entity_id]) => ({ id, entity_id })),
  links,
  offices,
});
test('splits and merges follow shared source documents, not names or new filings', () => {
  const before = snap([
    ['a', 'one'],
    ['b', 'one'],
    ['c', 'two'],
    ['d', 'three'],
  ]);
  const after = snap([
    ['a', 'left'],
    ['b', 'right'],
    ['c', 'joined'],
    ['d', 'joined'],
    ['new', 'joined'],
  ]);
  const r = comparePersons(before, after);
  assert.equal(r.movedDocuments, 4);
  assert.equal(r.addedDocuments, 1);
  assert.deepEqual(r.splits, [{ person: 'one', counterparts: ['left', 'right'] }]);
  assert.deepEqual(r.merges, [{ person: 'joined', counterparts: ['three', 'two'] }]);
  assert.equal(comparePersons(after, after).movedDocuments, 0);
  assert.deepEqual(comparePersons(after, after).splits, []);
});
test('rekeyed claims and institutional changes remain visible', () => {
  const a = {
    link_key: 'one|test',
    person_id: 'one',
    eik: '111111111',
    relation: 'owns',
    interest_class: 'private_ownership',
  };
  const b = { ...a, link_key: 'two|test', person_id: 'two' };
  const r = comparePersons(
    snap([], [a], [{ id: 'doc', institution: 'Община Тест' }]),
    snap([], [b], [{ id: 'doc', institution: 'Община Пример' }]),
  );
  assert.deepEqual(r.removedPublishedLinks, [a]);
  assert.deepEqual(r.addedPublishedLinks, [b]);
  assert.deepEqual(r.changedOffices, [{ declaration: 'doc' }]);
});
test('snapshot excludes inactive sources, registry identities and names', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE person_sources(id,entity_id,namespace,active,name);
      INSERT INTO person_sources VALUES('a','one','cacbg',1,'Ивана Петрова Тестова'),('b','two','tr',1,'Иван Петров Тестов'),('c','three','cacbg',0,'Петър Димитров Примеров');`);
    assert.deepEqual(JSON.parse(JSON.stringify(personSnapshot(db))), snap([['a', 'one']]));
  } finally {
    db.close();
  }
});
