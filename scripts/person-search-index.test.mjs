import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

test('indexes each person with a page once: declarants not already officials, and registered people', () => {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync('packages/db/migrations').sort())
    if (f.endsWith('.sql')) db.exec(readFileSync(`packages/db/migrations/${f}`, 'utf8'));
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
