import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  SCHEMA,
  MAX_HITS,
  pendingSearches,
  discover,
  unreadPartidas,
} from './discover-by-name.mjs';

const H = 'a'.repeat(64);
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE person_entities(id TEXT PRIMARY KEY, registry_indent TEXT);
    CREATE TABLE person_sources(id TEXT PRIMARY KEY, namespace TEXT, entity_id TEXT, active INTEGER, name TEXT);
    CREATE TABLE registry_persons(indent TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE registry_deeds(eik TEXT PRIMARY KEY);
    CREATE TABLE interest_links(person_id TEXT, status TEXT);
    INSERT INTO interest_links VALUES('p1','published');
    INSERT INTO person_entities VALUES('p1','${H}'),('p2',NULL);
    INSERT INTO person_sources VALUES('s1','cacbg','p1',1,'Ивана Петрова Тестова'),
      ('s2','cacbg','p1',1,'ИВАНА  ПЕТРОВА ТЕСТОВА'),('s3','cacbg','p1',1,'Ивана Петрова Примерова'),
      ('s4','cacbg','p1',0,'Стара Форма'),('s5','cacbg','p2',1,'Без Идентификатор'),('s6','tr','p1',1,'Ивана');
    INSERT INTO registry_persons VALUES('${H}','ИВАНА ПЕТРОВА ТЕСТОВА');
    INSERT INTO registry_deeds VALUES('000000001');`);
  db.exec(SCHEMA);
  return db;
}

test('searches each spelling once, skipping inactive, unidentified and one-word names', () => {
  const db = fixture();
  assert.deepEqual(pendingSearches(db), [
    { indent: H, name: 'ИВАНА ПЕТРОВА ПРИМЕРОВА' },
    { indent: H, name: 'ИВАНА ПЕТРОВА ТЕСТОВА' },
  ]);
  assert.equal(pendingSearches(db, 1).length, 1);
  db.exec("UPDATE interest_links SET status='held'");
  assert.deepEqual(pendingSearches(db), []);
  assert.equal(pendingSearches(db, Infinity, 'all').length, 2);
  db.exec("UPDATE interest_links SET status='published'");
  db.prepare('INSERT INTO registry_name_searches VALUES(?,?,0,?)').run(
    H,
    'ИВАНА ПЕТРОВА ТЕСТОВА',
    'now',
  );
  assert.deepEqual(pendingSearches(db), [{ indent: H, name: 'ИВАНА ПЕТРОВА ПРИМЕРОВА' }]);
});

test('records hits page by page, lists unread partidas, and leaves a too-common name unread', async () => {
  const db = fixture();
  const hit = (uic, name = 'ИВАНА ПЕТРОВА ТЕСТОВА') => ({
    uic,
    companyName: 'Фирма',
    fieldIdent: '00190',
    name,
  });
  const pages = [
    { items: [hit('000000001'), hit('000000002')], total: 3, hasMore: true },
    { items: [hit('000000002', 'ИВАНА ПЕТРОВА ТЕСТОВА-ИВАНОВА')], total: 3, hasMore: false },
  ];
  const client = { holdersNamed: async (_name, page) => pages[page - 1] };
  const r = await discover(db, client, { indent: H, name: 'Ивана Петрова Тестова' }, '2026-09-16');
  assert.deepEqual(r, { total: 3, recorded: 3 });
  assert.deepEqual(unreadPartidas(db), ['000000002']);
  const common = {
    holdersNamed: async () => ({ items: [hit('000000009')], total: MAX_HITS + 1, hasMore: true }),
  };
  const c = await discover(db, common, { indent: H, name: 'Иван Иванов' });
  assert.deepEqual(c, { total: MAX_HITS + 1, recorded: 0 });
  assert.deepEqual(unreadPartidas(db), ['000000002']);
  assert.equal(db.prepare('SELECT count(*) n FROM registry_name_searches').get().n, 2);
});
