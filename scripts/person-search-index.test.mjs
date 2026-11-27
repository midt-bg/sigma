import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

function createDb() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync('packages/db/migrations').sort())
    if (f.endsWith('.sql')) db.exec(readFileSync(`packages/db/migrations/${f}`, 'utf8'));
  return db;
}

test('indexes each person with a page once: declarants not already officials, and registered people', () => {
  const db = createDb();
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const C = 'c'.repeat(64);
  db.exec(`
    INSERT INTO persons(id,name) VALUES('person:official','Офицер'),('person:plain','Декларант Без Дял'),
      ('person:identity:x','Идентифициран Декларант'),('person:nodoc','Без Документи');
    INSERT INTO declarations(id,person_id,xml_file,folder_year,declared_year,template,category,institution,position,source_url)
      VALUES('d1','person:official','a.xml','2024','2023','assets','','Община','Кмет','u'),
            ('d2','person:plain','b.xml','2023','2022','assets','','Община','Съветник','u'),
            ('d3','person:plain','c.xml','2024','2023','assets','','Министерство','Експерт','u'),
            ('d4','person:identity:x','d.xml','2024','2023','assets','','Агенция','','u');
    INSERT INTO person_entities VALUES('person:identity:x','${B}','2026-01-01');
    INSERT INTO registry_persons(indent,name) VALUES('${A}','Вписано Лице'),('${B}','Идентифициран Декларант'),('${C}','Само Бивш');
    INSERT INTO bidders(id,name,kind,eik_normalized) VALUES('eik:111111111','АЛФА ООД','company','111111111'),('eik:222222222','БЕТА ООД','company','222222222');
    INSERT INTO company_totals(bidder_id,name,kind,won_eur,contracts,authorities)
      VALUES('eik:111111111','АЛФА ООД','company',1,1,1),('eik:222222222','БЕТА ООД','company',0,0,0);
    INSERT INTO registry_roles(eik,sub_uic,field_ident,role,subject_kind,subject_id,subject_name,entry_number,added_on)
      VALUES('111111111','0000','00070','manager','person','${A}','Вписано Лице','e1','2020-01-01'),
            ('111111111','0000','00190','partner','person','${B}','Идентифициран Декларант','e1','2020-01-01'),
            ('222222222','0000','00190','partner','person','${C}','Само Бивш','e1','2020-01-01'),
            ('111111111','0000','05500','beneficial_owner','person','${C}','Само Бивш','e1','2020-01-01');
    INSERT INTO search_index(kind,ref,title) VALUES('official','person:official','Офицер');`);
  db.exec(readFileSync('scripts/person-search-index.sql', 'utf8'));
  db.exec(readFileSync('scripts/person-search-index.sql', 'utf8'));
  const rows = db
    .prepare("SELECT ref, title, subtitle FROM search_index WHERE kind='person' ORDER BY ref")
    .all()
    .map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { ref: A, title: 'Вписано Лице', subtitle: 'АЛФА ООД' },
    {
      ref: 'person:identity:x',
      title: 'Идентифициран Декларант',
      subtitle: 'Агенция',
    },
    { ref: 'person:plain', title: 'Декларант Без Дял', subtitle: 'Експерт · Министерство' },
  ]);
  db.close();
});

test('orders companies with an active role first regardless of role insertion order', (t) => {
  const db = createDb();
  t.after(() => db.close());
  const person = 'd'.repeat(64);
  const personName = 'Тестово Вписано Лице';
  const formerCompany = 'А ТЕСТ БИВША ЕООД';
  const mixedCompany = 'Б ТЕСТ АКТИВНА ЕООД';
  db.exec(`
    INSERT INTO registry_persons(indent,name) VALUES('${person}','${personName}');
    INSERT INTO bidders(id,name,kind,eik_normalized)
      VALUES('eik:000000001','${formerCompany}','company','000000001'),
            ('eik:000000002','${mixedCompany}','company','000000002');
    INSERT INTO company_totals(bidder_id,name,kind,won_eur,contracts,authorities)
      VALUES('eik:000000001','${formerCompany}','company',1,1,1),
            ('eik:000000002','${mixedCompany}','company',1,1,1);`);
  const insertRole = db.prepare(`
    INSERT INTO registry_roles(eik,sub_uic,field_ident,role,subject_kind,subject_id,subject_name,entry_number,added_on,removed_on)
    VALUES(?,'0000','00070','manager','person',?,?,?,'2020-01-01',?)`);
  const roles = [
    ['000000001', 'former', '2021-01-01'],
    ['000000002', 'former', '2021-01-01'],
    ['000000002', 'active', null],
  ];
  const rebuild = readFileSync('scripts/person-search-index.sql', 'utf8');
  const subtitle = db.prepare(
    "SELECT subtitle FROM search_index WHERE kind = 'person' AND ref = ?",
  );
  const subtitles = [roles, roles.toReversed()].map((orderedRoles) => {
    db.exec('DELETE FROM registry_roles');
    for (const [eik, entry, removedOn] of orderedRoles) {
      insertRole.run(eik, person, personName, entry, removedOn);
    }
    db.exec(rebuild);
    return subtitle.get(person).subtitle;
  });
  const expected = `${mixedCompany}, ${formerCompany}`;
  assert.deepEqual(subtitles, [expected, expected]);
});

test('caps subtitles at top 2 companies in deterministic (active, name) order across 1-, 2-, and 3-company cases', (t) => {
  const db = createDb();
  t.after(() => db.close());
  const oneCo = '1'.repeat(64);
  const oneActiveTwoFormer = '2'.repeat(64);
  const threeActive = '3'.repeat(64);
  const companies = [
    ['000000011', 'А ТЕСТ ПЪРВА ЕООД'],
    ['000000012', 'Б ТЕСТ ВТОРА ЕООД'],
    ['000000013', 'В ТЕСТ ТРЕТА ЕООД'],
    ['000000014', 'Г ТЕСТ ЧЕТВЪРТА ЕООД'],
  ];
  db.exec(`
    INSERT INTO registry_persons(indent,name) VALUES
      ('${oneCo}','Тест Една Компания'),
      ('${oneActiveTwoFormer}','Тест Една Активна Две Бивши'),
      ('${threeActive}','Тест Три Активни');`);
  const addCompany = db.prepare(
    "INSERT INTO bidders(id,name,kind,eik_normalized) VALUES(?,?,'company',?)",
  );
  const addTotal = db.prepare(
    "INSERT INTO company_totals(bidder_id,name,kind,won_eur,contracts,authorities) VALUES(?,?,'company',1,1,1)",
  );
  for (const [eik, name] of companies) {
    addCompany.run(`eik:${eik}`, name, eik);
    addTotal.run(`eik:${eik}`, name);
  }
  const insertRole = db.prepare(`
    INSERT INTO registry_roles(eik,sub_uic,field_ident,role,subject_kind,subject_id,subject_name,entry_number,added_on,removed_on)
    VALUES(?,'0000','00070','manager','person',?,?,?,'2020-01-01',?)`);
  const roles = [
    // 1 company -> no trailing separator
    ['000000013', oneCo, 'Тест Една Компания', 'e1', null],
    // 1 active (with both former + active rows, alphabetically last) + 2 former -> active first, then alphabetically first former
    ['000000012', oneActiveTwoFormer, 'Тест Една Активна Две Бивши', 'f2', '2021-01-01'],
    ['000000011', oneActiveTwoFormer, 'Тест Една Активна Две Бивши', 'f1', '2021-01-01'],
    ['000000014', oneActiveTwoFormer, 'Тест Една Активна Две Бивши', 'f4', '2021-01-01'],
    ['000000014', oneActiveTwoFormer, 'Тест Една Активна Две Бивши', 'a4', null],
    // 3 active companies -> caps at top 2 alphabetically
    ['000000013', threeActive, 'Тест Три Активни', 'a3', null],
    ['000000011', threeActive, 'Тест Три Активни', 'a1', null],
    ['000000012', threeActive, 'Тест Три Активни', 'a2', null],
  ];
  const rebuild = readFileSync('scripts/person-search-index.sql', 'utf8');
  const subtitle = db.prepare(
    "SELECT subtitle FROM search_index WHERE kind = 'person' AND ref = ?",
  );
  for (const orderedRoles of [roles, roles.toReversed()]) {
    db.exec('DELETE FROM registry_roles');
    for (const [eik, indent, personName, entry, removedOn] of orderedRoles) {
      insertRole.run(eik, indent, personName, entry, removedOn);
    }
    db.exec(rebuild);
    assert.equal(subtitle.get(oneCo).subtitle, 'В ТЕСТ ТРЕТА ЕООД');
    assert.equal(
      subtitle.get(oneActiveTwoFormer).subtitle,
      'Г ТЕСТ ЧЕТВЪРТА ЕООД, А ТЕСТ ПЪРВА ЕООД',
    );
    assert.equal(subtitle.get(threeActive).subtitle, 'А ТЕСТ ПЪРВА ЕООД, Б ТЕСТ ВТОРА ЕООД');
  }
});

test('person-search-index.sql avoids SQLite 3.44+ aggregate ORDER BY syntax', () => {
  const sql = readFileSync('scripts/person-search-index.sql', 'utf8');
  assert.doesNotMatch(sql, /\b(?:group_concat|string_agg)\s*\([^)]*\border\s+by\b/i);
});
