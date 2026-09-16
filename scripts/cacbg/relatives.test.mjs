import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildPersonRelatives } from './relatives.mjs';

test('names a relative only when the register lists them at the declared company under the declared three names', () => {
  const db = new DatabaseSync(':memory:');
  const H = 'h'.repeat(64);
  db.exec(`CREATE TABLE persons(id PRIMARY KEY);
    CREATE TABLE interest_links(link_key,person_id,eik,status,interest_class);
    CREATE TABLE interest_link_observations(link_key,declaration_id);
    CREATE TABLE related_persons_internal(declaration_id,related_name,related_kind);
    CREATE TABLE registry_roles(eik,subject_kind,subject_id,subject_name);
    CREATE TABLE registry_persons(indent,name);
    INSERT INTO persons VALUES('p');
    INSERT INTO interest_links VALUES('f','p','111','published','family_ownership'),('s','p','222','published','private_ownership'),('h','p','333','held','family_ownership');
    INSERT INTO interest_link_observations VALUES('f','d1'),('s','d1'),('h','d1');
    INSERT INTO related_persons_internal VALUES('d1','Мария Иванова Петрова','stake_holder'),('d1','Петър Иванов','stake_holder'),('d1','Мария Иванова Петрова','related_person'),('d1','Фирма ООД','related_contract');
    INSERT INTO registry_roles VALUES('111','person','${H}','МАРИЯ ИВАНОВА ПЕТРОВА'),('111','person','local:111:ПЕТЪР ИВАНОВ','ПЕТЪР ИВАНОВ'),
      ('222','person','${'x'.repeat(64)}','МАРИЯ ИВАНОВА ПЕТРОВА'),('333','person','${'y'.repeat(64)}','МАРИЯ ИВАНОВА ПЕТРОВА'),('111','person','${'z'.repeat(64)}','ИВАН ПЕТРОВ ГЕОРГИЕВ');
    INSERT INTO registry_persons VALUES('${H}','Мария Иванова Петрова');`);
  db.exec(
    fs.readFileSync(
      new URL('../../packages/db/migrations/0022_person_relatives.sql', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(buildPersonRelatives(db), 1);
  assert.deepEqual(
    db
      .prepare('SELECT * FROM person_relatives')
      .all()
      .map((r) => ({ ...r })),
    [{ person_id: 'p', relative_indent: H, eik: '111', relative_name: 'Мария Иванова Петрова' }],
  );

  assert.equal(buildPersonRelatives(db), 1); // rebuilt, not duplicated
  db.close();
});
