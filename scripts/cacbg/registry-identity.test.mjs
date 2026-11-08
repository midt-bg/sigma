import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  namesakeResolver,
  registryIdentityResolver,
  mixedScriptCompanyKey,
  identityInputsDigest,
} from './registry-identity.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE registry_deeds(eik,name,legal_form,seat_settlement,outcome);
    CREATE TABLE registry_roles(eik,subject_id,subject_name,entry_number,subject_kind,role);
    INSERT INTO registry_deeds VALUES('123456789','А ТЕСТ ПРО','OOD','София','ok'),('987654321','ДРУГА ФИРМА','OOD','Пловдив','ok');`);
  db.exec(
    readFileSync(
      new URL(
        '../../packages/db/migrations/0017_registry_identity_observations.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  let entry = 0;
  const add = (eik, id, name, type = 'EGN') =>
    db
      .prepare('INSERT INTO registry_identity_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        eik,
        '1',
        '00190',
        String(++entry),
        '2019-01-01',
        0,
        id,
        type,
        name,
        name,
        'person',
        'f'.repeat(64),
        '2026-01-01',
      );
  const name = 'Ивана Петрова Тестова';
  const alias = 'Ивана Петрова Тестова-Примерова';
  const doc = {
    declarant: name,
    interests: [
      { entity: 'А Тест Про ООД', kind: 'shares', holderRelation: 'self', seat: 'София' },
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

test('a date-of-birth observation cannot establish a global identity even with an exact name', () => {
  const { db, add, name, doc } = fixture();
  try {
    add('123456789', 'a'.repeat(64), name, 'BirthDate');
    assert.deepEqual(registryIdentityResolver(db)(doc, [name]).evidence, []);
  } finally {
    db.close();
  }
});

test('historic forms resolve only through observed name/form pairs on the same EIK', () => {
  const { db, add, name, doc } = fixture();
  try {
    db.exec(
      readFileSync(
        new URL('../../packages/db/migrations/0020_registry_company_history.sql', import.meta.url),
        'utf8',
      ),
    );
    db.exec("UPDATE registry_deeds SET legal_form='EOOD' WHERE eik='123456789'");
    add('123456789', 'a'.repeat(64), name);
    // Without the history the other form is only a stem match, which names the company because the
    // declarant stands in it.
    const method = () => registryIdentityResolver(db)(doc, [name]).companies[0]?.method;
    assert.equal(method(), 'registry_name_stem');
    const historic = {
      name: 'А Тест Про',
      legalForm: 'ООД',
      from: '2010-01-01T12:00:00',
      until: '2020-01-01T12:00:00',
      subUic: '1',
      nameEntry: '20100101120000',
      formEntry: '20100101120000',
    };
    db.prepare('INSERT INTO registry_company_history VALUES(?,?,?,?)').run(
      '123456789',
      JSON.stringify([historic]),
      'c'.repeat(64),
      '2026-01-01',
    );
    db.prepare('INSERT INTO registry_identity_snapshots VALUES(?,?,?)').run(
      '123456789',
      'c'.repeat(64),
      '2026-01-01',
    );
    for (const entity of ['А Тест Про ООД', 'А Тест Про ООД, ЕИК 123456789']) {
      const r = registryIdentityResolver(db)(
        { ...doc, interests: [{ ...doc.interests[0], entity }] },
        [name],
      );
      assert.equal(r.evidence[0].registryIndent, 'a'.repeat(64));
      assert.equal(r.companies[0].method, 'registry_name_history');
      assert.equal(r.companies[0].registryCompany.formEntry, historic.formEntry);
    }
    db.prepare('UPDATE registry_identity_snapshots SET source_hash=?').run('d'.repeat(64));
    assert.equal(
      method(),
      'registry_name_stem',
      'history from a superseded snapshot is not current evidence',
    );
    db.prepare('UPDATE registry_identity_snapshots SET source_hash=?').run('c'.repeat(64));
    db.exec("UPDATE registry_deeds SET name='А ТЕСТ ПРО', legal_form='OOD' WHERE eik='987654321'");
    assert.equal(
      registryIdentityResolver(db)(doc, [name]).evidence.length,
      0,
      'another EIK carrying this full name is ambiguous',
    );
  } finally {
    db.close();
  }
});

test('a stem match needs the declarant in the partida; the seat plays no part', () => {
  const { db, add, name, doc } = fixture();
  try {
    const stem = { ...doc, interests: [{ ...doc.interests[0], entity: '„А-Тест Про“ ЕООД' }] };
    add('123456789', 'b'.repeat(64), 'Друга Петрова Тестова');
    assert.deepEqual(registryIdentityResolver(db)(stem, [name]).companies, []);
    add('123456789', 'a'.repeat(64), name);
    for (const seat of ['София', 'Варна', '']) {
      const declared = { ...stem, interests: [{ ...stem.interests[0], seat }] };
      const found = registryIdentityResolver(db)(declared, [name]);
      assert.equal(found.companies[0].method, 'registry_name_stem', seat);
      assert.equal(found.evidence[0].registryIndent, 'a'.repeat(64), seat);
    }
    const related = { ...stem, interests: [{ ...stem.interests[0], holderRelation: 'related' }] };
    assert.deepEqual(registryIdentityResolver(db)(related, [name]).companies, []);
  } finally {
    db.close();
  }
});

test('mixed-script company names need unique company and personal registry corroboration', () => {
  const { db, add, name, doc } = fixture();
  try {
    db.exec("UPDATE registry_deeds SET name='АЛФА Be АИК' WHERE eik='123456789'");
    const d = { ...doc, interests: [{ ...doc.interests[0], entity: 'АЛФА ВЕ АИК ООД', seat: '' }] };
    assert.equal(
      registryIdentityResolver(db)(d, [name]).companies.length,
      0,
      'visual similarity alone is insufficient',
    );
    add('123456789', 'a'.repeat(64), name);
    let r = registryIdentityResolver(db)(d, [name]);
    assert.equal(r.evidence[0].registryIndent, 'a'.repeat(64));
    assert.equal(r.companies[0].method, 'registry_mixed_script');
    assert.equal(
      registryIdentityResolver(db)(
        { ...d, interests: [{ ...d.interests[0], holderRelation: 'related' }] },
        [name],
      ).companies.length,
      0,
    );
    db.exec("UPDATE registry_deeds SET name='АЛФА BЕ АИК' WHERE eik='987654321'");
    assert.equal(
      registryIdentityResolver(db)(d, [name]).companies.length,
      0,
      'normalization collision must not choose an EIK',
    );
    db.exec("DELETE FROM registry_deeds WHERE eik='987654321'");
    add('123456789', 'b'.repeat(64), name);
    assert.equal(
      registryIdentityResolver(db)(d, [name]).companies.length,
      0,
      'two namesakes under the same EIK',
    );
  } finally {
    db.close();
  }
});

test('visual comparison retains phonetic spellings, punctuation, forms and purely Latin names', () => {
  assert.equal(mixedScriptCompanyKey('АЛФА Be АИК ООД'), 'АЛФА ВЕ АИК ООД');
  for (const name of ['ALFA BE OOD', 'АЛФА VE АИК ООД', 'АЛФА ВЕ-АИК ЕООД'])
    assert.equal(mixedScriptCompanyKey(name), name);
  const { db, add, name, doc } = fixture();
  try {
    db.exec("UPDATE registry_deeds SET name='АЛФА Be АИК' WHERE eik='123456789'");
    add('123456789', 'local:not-a-person', name);
    const d = { ...doc, interests: [{ ...doc.interests[0], entity: 'АЛФА ВЕ АИК ООД' }] };
    assert.equal(registryIdentityResolver(db)(d, [name]).companies.length, 0);
  } finally {
    db.close();
  }
});

test('the identity input digest follows the facts, not the physical row order', () => {
  const rows = [
    ['123456789', 'a'.repeat(64), 'Ивана Петрова Тестова', '1'],
    ['987654321', 'b'.repeat(64), 'Иван Петров Тестов', '2'],
  ];
  const seed = (order) => {
    const { db } = fixture();
    const insert = db.prepare(
      'INSERT INTO registry_identity_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (const [eik, id, name, entry] of order)
      insert.run(
        eik,
        '1',
        '00190',
        entry,
        '2019-01-01',
        0,
        id,
        'EGN',
        name,
        name,
        'person',
        'f'.repeat(64),
        '2026-01-01',
      );
    return db;
  };
  const a = seed(rows);
  const b = seed([...rows].reverse());
  const before = identityInputsDigest(a);
  assert.equal(before, identityInputsDigest(b));
  b.exec("UPDATE registry_deeds SET name='ДРУГО ИМЕ' WHERE eik='987654321'");
  assert.notEqual(before, identityInputsDigest(b));
  a.close();
  b.close();
});

test('a namesake is settled only by the one partida that names the holder in full', () => {
  const { db, add, name } = fixture();
  const read = (eik) =>
    db.prepare("INSERT INTO registry_identity_snapshots VALUES(?,'h','2026-01-01')").run(eik);
  try {
    const eiks = ['123456789', '987654321'];
    add('987654321', 'a'.repeat(64), name);
    read('987654321');
    // The other partida is unread: it may hold the very person, so nothing is chosen yet.
    assert.equal(namesakeResolver(db)(eiks, name), null, 'a namesake partida is unread');
    read('123456789');
    assert.equal(namesakeResolver(db)(eiks, name), '987654321');
    assert.equal(namesakeResolver(db)(eiks, [name]), '987654321');
    assert.equal(namesakeResolver(db)(eiks, ['Друго Лице Тестово', name]), '987654321');
    assert.equal(namesakeResolver(db)(eiks, 'Ивана Тестова'), null, 'two names are not enough');
    assert.equal(namesakeResolver(db)(eiks, undefined), null);
    assert.equal(namesakeResolver(db)(eiks, []), null);
    // Someone in the other partida who could be the holder is enough to refuse, though not to choose.
    for (const [other, why] of [
      ['Ивана Тестова', 'a shorter name'],
      ['Ивана Петрова Тестова-Примерова', 'a variant spelling'],
    ]) {
      add('123456789', 'b'.repeat(64), other);
      assert.equal(namesakeResolver(db)(eiks, name), null, why);
      db.prepare('DELETE FROM registry_identity_observations WHERE eik=?').run('123456789');
    }
    // As the register's writer stores them: a birth date or no identifier is `other` with no indent, two
    // holders under one identifier are `collective`.
    const observe = (kind, indent, type, holder) =>
      db
        .prepare(
          "INSERT INTO registry_identity_observations VALUES(?,'1','00190',?,'2019-01-01',0,?,?,?,?,?,?,'2026-01-01')",
        )
        .run('123456789', String(++entry), indent, type, holder, holder, kind, 'f'.repeat(64));
    let entry = 1000;
    for (const [kind, indent, type, why] of [
      ['other', null, 'BirthDate', 'a birth date for an identifier'],
      ['other', null, 'UNDEFINED', 'no identifier'],
      ['collective', 'd'.repeat(64), 'EGN', 'a collective row'],
    ]) {
      observe(kind, indent, type, name);
      assert.equal(namesakeResolver(db)(eiks, name), null, why);
      db.prepare('DELETE FROM registry_identity_observations WHERE eik=?').run('123456789');
    }
    observe('other', '123456789', 'UIC', name);
    assert.equal(namesakeResolver(db)(eiks, name), '987654321', 'a company is not a person');
    db.prepare('DELETE FROM registry_identity_observations WHERE eik=?').run('123456789');
    add('123456789', 'b'.repeat(64), 'Иван Петров Тестов');
    assert.equal(namesakeResolver(db)(eiks, name), '987654321', 'a different person');
    add('123456789', 'c'.repeat(64), name);
    assert.equal(namesakeResolver(db)(eiks, name), null, 'named in both partidas');
  } finally {
    db.close();
  }
});

test('a newly read namesake without the declarant preserves the registry identity and company answer', () => {
  const { db, add, name, doc } = fixture();
  try {
    add('123456789', 'a'.repeat(64), name);
    db.exec("INSERT INTO registry_identity_snapshots VALUES('123456789','hash','now')");
    const before = registryIdentityResolver(db)(doc, [name]);
    db.exec("UPDATE registry_deeds SET name='А ТЕСТ ПРО' WHERE eik='987654321'");
    db.exec("INSERT INTO registry_identity_snapshots VALUES('987654321','hash','now')");
    add('987654321', 'b'.repeat(64), 'Петър Димитров Примеров');
    const after = registryIdentityResolver(db)(doc, [name]);
    assert.deepEqual(after.evidence, before.evidence);
    assert.equal(after.companies[0].eik, before.companies[0].eik);
    assert.equal(after.companies[0].method, 'registry_namesake');
    // A real competing observation revokes the choice; identities are never made sticky.
    add('987654321', 'c'.repeat(64), name);
    assert.deepEqual(registryIdentityResolver(db)(doc, [name]).evidence, []);
  } finally {
    db.close();
  }
});

test('an unread procurement namesake is visible to identity resolution too', () => {
  const { db, add, name, doc } = fixture();
  try {
    add('123456789', 'a'.repeat(64), name);
    db.exec("INSERT INTO registry_identity_snapshots VALUES('123456789','hash','now')");
    db.exec(`CREATE TABLE bidders(name,eik_normalized,eik_valid);
      INSERT INTO bidders VALUES('А ТЕСТ ПРО ООД','111111111',1);`);
    assert.equal(registryIdentityResolver(db)(doc, [name]).reason, 'company_not_resolved');
  } finally {
    db.close();
  }
});
