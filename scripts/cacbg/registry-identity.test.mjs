import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { registryIdentityResolver } from './registry-identity.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE registry_deeds(eik,name,legal_form,seat_settlement,outcome);
    CREATE TABLE registry_roles(eik,subject_id,subject_name,entry_number,subject_kind,role);
    INSERT INTO registry_deeds VALUES('123456789','А ДЕЙТА ПРО','OOD','София','ok'),('987654321','ДРУГА ФИРМА','OOD','Пловдив','ok');`);
  const add = (eik, id, name) =>
    db
      .prepare("INSERT INTO registry_roles VALUES(?,?,?,'20190101120000','person','partner')")
      .run(eik, id, name);
  const name = 'Ивана Петрова Тестова';
  const alias = 'Ивана Петрова Тестова-Примерова';
  const doc = {
    declarant: name,
    interests: [
      { entity: 'А Дейта Про ООД', kind: 'shares', holderRelation: 'self', seat: 'София' },
    ],
  };
  return { db, add, name, alias, doc };
}
test('registry aliases resolve a changed name through one Indent and the declared company', () => {
  const { db, add, name, alias, doc } = fixture();
  try {
    add('123456789', 'a'.repeat(64), name);
    add('123456789', 'a'.repeat(64), alias);
    const identify = registryIdentityResolver(db);
    const result = identify(doc, [alias]);
    assert.equal(result.attribution, 'registry_alias');
    assert.equal(result.evidence[0].registryIndent, 'a'.repeat(64));
    assert.equal(result.evidence[0].documentName, name);
    assert.equal(identify(doc, [alias, name]).attribution, 'registry_alias');
    assert.equal(identify({ ...doc, interests: [] }, [alias]).attribution, 'declarant_mismatch');
    assert.equal(
      identify({ ...doc, interests: [{ ...doc.interests[0], holderRelation: 'related' }] }, [alias])
        .attribution,
      'declarant_mismatch',
    );
  } finally {
    db.close();
  }
});
test('same names with different Indent, aliases in another company and local ids cannot establish identity', () => {
  for (const mode of ['different', 'homonym', 'company', 'local']) {
    const { db, add, name, alias, doc } = fixture();
    try {
      add('123456789', mode === 'local' ? 'local:123' : 'a'.repeat(64), name);
      add(
        mode === 'company' ? '987654321' : '123456789',
        mode === 'different' ? 'b'.repeat(64) : mode === 'local' ? 'local:123' : 'a'.repeat(64),
        alias,
      );
      if (mode === 'homonym') add('123456789', 'c'.repeat(64), name);
      assert.equal(
        registryIdentityResolver(db)(doc, [alias]).attribution,
        'declarant_mismatch',
        mode,
      );
    } finally {
      db.close();
    }
  }
});
