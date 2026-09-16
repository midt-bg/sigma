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

test('full name and a verified company establish an author across years without a personal TR identity', () => {
  const { db, filing, name } = fixture();
  try {
    const companies = registryIdentityResolver(db)(
      {
        declarant: name,
        interests: [
          {
            entity: 'Тест информация ООД',
            seat: 'София',
            kind: 'shares',
            holderRelation: 'related',
          },
        ],
      },
      [name],
    ).companies;
    const a = { ...filing('a.xml'), identityEvidence: [], companyEvidence: companies, year: 2018 };
    const b = {
      ...a,
      xmlFile: 'b.xml',
      year: 2025,
      work: 'Друга институция',
      declaredPosition: 'Друга длъжност',
    };
    const empty = { ...b, xmlFile: 'empty.xml', companyEvidence: [], year: 2026 };
    const part = { ...empty, xmlFile: 'part.xml', work: '', declaredPosition: '', year: null };
    const other = { ...b, xmlFile: 'other.xml', person: 'Ивана Димитрова Тестова' };
    const group = {
      folder: '2025',
      listHash: 'a'.repeat(64),
      personLocator: 1,
      name,
      members: [b, part].map((f) => ({
        sourceId: declarationSourceId(f),
        sourceHash: f.sourceHash,
      })),
    };
    const r = rebuildPersonEntities(
      db,
      db,
      [a, b, empty, other, part],
      legacy,
      new Map(),
      undefined,
      [group],
    );
    const id = r.assignments.get(declarationSourceId(a));
    assert.match(id, /^person:identity:/);
    assert.equal(r.stats.resolved, 4);
    assert.equal(r.assignments.get(declarationSourceId(empty)), id);
    assert.equal(r.assignments.get(declarationSourceId(part)), id);
    assert.equal(r.assignments.get(declarationSourceId(other)), legacy(other));
    assert.equal(
      db.prepare('SELECT registry_indent FROM person_entities WHERE id=?').get(id).registry_indent,
      null,
    );
    db.prepare('INSERT INTO persons VALUES(?,?)').run(id, name);
    assert.equal(buildPersonRegistryLinks(db).linked, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM registry_roles').get().n, 0);
    const noYear = { ...a, xmlFile: '0.xml', year: null };
    const repeat = rebuildPersonEntities(db, db, [empty, b, a, noYear], legacy);
    assert.equal(repeat.assignments.get(declarationSourceId(noYear)), id);
    const withdrawn = rebuildPersonEntities(
      db,
      db,
      [a, { ...b, companyEvidence: [], sourceHash: 'd'.repeat(64) }, empty],
      legacy,
    );
    assert.equal(withdrawn.stats.resolved, 0);
    assert.ok(
      db
        .prepare('SELECT 1 FROM person_source_aliases WHERE alias_id=? AND source_id=?')
        .get(id, declarationSourceId(b)),
    );
  } finally {
    db.close();
  }
});

test('two namesakes with different registry identifiers in the common company block the company bridge', () => {
  const { db, filing, name, add, b } = fixture();
  try {
    const companies = registryIdentityResolver(db)(
      {
        declarant: name,
        interests: [
          {
            entity: 'Тест информация ООД',
            seat: 'София',
            kind: 'shares',
            holderRelation: 'related',
          },
        ],
      },
      [name],
    ).companies;
    const a = { ...filing('a.xml'), identityEvidence: [], companyEvidence: companies, year: 2023 };
    const second = { ...a, xmlFile: 'b.xml', year: 2024 };
    assert.equal(rebuildPersonEntities(db, db, [a, second], legacy).stats.resolved, 2);
    add(b, name, '20240101120000');
    const r = rebuildPersonEntities(db, db, [a, second], legacy);
    assert.equal(r.stats.resolved, 0);
    assert.equal(
      db.prepare("SELECT count(*) n FROM person_identity_evidence WHERE decision='accepted'").get()
        .n,
      0,
    );
  } finally {
    db.close();
  }
});

test('employment continuity attaches empty declarations, preserves aliases and revokes corrected sources', () => {
  const { db, filing } = fixture();
  try {
    const anchor = {
      ...filing('anchor.xml'),
      work: 'Община Тест',
      declaredPosition: 'Директор',
      year: 2023,
    };
    const empty = { ...anchor, xmlFile: 'empty.xml', identityEvidence: [], year: 2024 };
    const next = { ...empty, xmlFile: 'next.xml', year: 2025 };
    const gap = { ...empty, xmlFile: 'gap.xml', year: 2027 };
    const role = { ...empty, xmlFile: 'role.xml', declaredPosition: 'Съветник' };
    const place = { ...empty, xmlFile: 'place.xml', work: 'Друга община' };
    const records = [anchor, empty, next, gap, role, place];
    const before = rebuildPersonEntities(db, db, records, legacy);
    const id = before.assignments.get(declarationSourceId(anchor));
    assert.equal(before.stats.resolved, 3);
    assert.equal(before.assignments.get(declarationSourceId(next)), id);
    const rows = () =>
      db.prepare('SELECT id,decision,facts FROM person_identity_evidence ORDER BY id').all();
    const evidence = rows();
    rebuildPersonEntities(db, db, [...records].reverse(), legacy);
    assert.deepEqual(rows(), evidence);
    const corrected = records.map((f) =>
      f === empty ? { ...f, work: 'Друга община', sourceHash: 'c'.repeat(64) } : f,
    );
    const after = rebuildPersonEntities(db, db, corrected, legacy);
    assert.equal(after.stats.resolved, 1);
    assert.equal(after.assignments.get(declarationSourceId(anchor)), id);
    assert.equal(after.assignments.get(declarationSourceId(next)), legacy(next));
    assert.ok(
      db
        .prepare('SELECT 1 FROM person_source_aliases WHERE alias_id=? AND source_id=?')
        .get(id, declarationSourceId(next)),
    );
  } finally {
    db.close();
  }
});

test('shared verified company bridges offices and roles without inventing personal ownership', () => {
  const { db, filing, name } = fixture();
  try {
    const companies = registryIdentityResolver(db)(
      {
        declarant: name,
        interests: [
          {
            entity: 'Тест информация ООД',
            seat: 'София',
            kind: 'shares',
            holderRelation: 'related',
          },
        ],
      },
      [name],
    ).companies;
    const anchor = {
      ...filing('anchor.xml'),
      year: 2023,
      work: 'Община А',
      declaredPosition: 'Архитект',
      companyEvidence: companies,
    };
    const moved = {
      ...anchor,
      xmlFile: 'moved.xml',
      year: 2024,
      work: 'Община Б',
      identityEvidence: [],
    };
    const unrelated = { ...moved, xmlFile: 'unrelated.xml', declaredPosition: 'Съветник' };
    const r = rebuildPersonEntities(db, db, [anchor, moved, unrelated], legacy);
    // Same company/work links the third document to moved, but never creates a TR role or self stake.
    assert.equal(r.stats.resolved, 3);
    assert.equal(companies[0].holderRelation, 'related');
    assert.equal(db.prepare('SELECT count(*) n FROM registry_roles').get().n, 0);
    const companyOnly = { ...unrelated, work: 'Община В' };
    assert.equal(rebuildPersonEntities(db, db, [anchor, companyOnly], legacy).stats.resolved, 2);
    const tampered = { ...moved, companyEvidence: [{ ...companies[0], eik: '987654321' }] };
    assert.throws(
      () => rebuildPersonEntities(db, db, [anchor, tampered], legacy),
      /Company continuity proof/,
    );
  } finally {
    db.close();
  }
});

test('new continuity cannot collapse different proven identities or adopt an ambiguous registry candidate', () => {
  const { db, filing, add, name, b } = fixture();
  try {
    const anchor = {
      ...filing('anchor.xml'),
      work: 'Община А',
      declaredPosition: 'Архитект',
      year: 2023,
    };
    db.exec("INSERT INTO registry_deeds VALUES('987654321','ДРУГА ИНФОРМАЦИЯ','OOD','София','ok')");
    db.prepare(
      `INSERT INTO registry_identity_observations SELECT '987654321',sub_uic,field_ident,
      entry_number,entry_on,holder_index,?,indent_type,name,name_key,subject_kind,source_hash,fetched_at
      FROM registry_identity_observations WHERE name=?`,
    ).run(b, name);
    const evidence = registryIdentityResolver(db)(
      {
        declarant: name,
        interests: [
          { entity: 'Друга информация ООД', seat: 'София', kind: 'shares', holderRelation: 'self' },
        ],
      },
      [name],
    ).evidence;
    const other = { ...anchor, xmlFile: 'other.xml', year: 2024, identityEvidence: evidence };
    const empty = { ...anchor, xmlFile: 'empty.xml', identityEvidence: [] };
    const r = rebuildPersonEntities(db, db, [anchor, other, empty], legacy);
    assert.equal(r.stats.resolved, 2);
    assert.notEqual(
      r.assignments.get(declarationSourceId(anchor)),
      r.assignments.get(declarationSourceId(other)),
    );
    assert.equal(r.assignments.get(declarationSourceId(empty)), legacy(empty));
    assert.ok(r.stats.continuityCandidates > 0);
    const companyEvidence = registryIdentityResolver(db)(
      {
        declarant: name,
        interests: [
          {
            entity: 'Тест информация ООД',
            seat: 'София',
            kind: 'shares',
            holderRelation: 'related',
          },
        ],
      },
      [name],
    ).companies;
    const companyConflict = rebuildPersonEntities(
      db,
      db,
      [anchor, other, empty].map((f) => ({ ...f, companyEvidence })),
      legacy,
    );
    assert.equal(companyConflict.stats.resolved, 2);
    assert.equal(
      companyConflict.assignments.get(declarationSourceId(empty)),
      legacy(empty),
      'rejected company evidence must not create a standalone author',
    );
    add(b, name, '20220101120000');
    const ambiguous = { ...empty, identityEvidence: filing('empty.xml').identityEvidence };
    const again = rebuildPersonEntities(db, db, [other, ambiguous], legacy);
    assert.equal(again.stats.resolved, 1);
    assert.equal(again.assignments.get(declarationSourceId(ambiguous)), legacy(ambiguous));
  } finally {
    db.close();
  }
});
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
test('automatic evidence connects only its scoped sources and an explicit difference blocks the component', () => {
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
    origin: 'automatic',
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

test('listing groups attach empty filings, reject namesakes and manual evidence, and revoke changed membership', () => {
  const { db, filing, name } = fixture();
  try {
    const a = filing('1.xml');
    const b = { ...filing('2.xml'), sourceHash: 'd'.repeat(64), identityEvidence: [] };
    const c = { ...filing('3.xml'), sourceHash: 'c'.repeat(64), identityEvidence: [] };
    const group = (members, listHash = 'f'.repeat(64)) => ({
      folder: '2025',
      listHash,
      personLocator: 1,
      name,
      members: members.map((f) => ({
        sourceId: declarationSourceId(f),
        sourceHash: f.sourceHash,
        xmlFile: f.xmlFile,
      })),
    });
    const run = (groups) =>
      rebuildPersonEntities(db, db, [a, b, c], legacy, new Map(), '2026-01-01', groups);
    const first = run([group([a, b])]);
    const id = first.assignments.get(declarationSourceId(a));
    assert.equal(first.assignments.get(declarationSourceId(b)), id);
    assert.equal(first.assignments.get(declarationSourceId(c)), legacy(c));
    const clean = fixture();
    try {
      assert.deepEqual(
        [
          ...rebuildPersonEntities(clean.db, clean.db, [a, b, c], legacy, new Map(), '2026-01-01', [
            group([a, b]),
          ]).assignments,
        ],
        [...first.assignments],
      );
    } finally {
      clean.db.close();
    }
    db.prepare(
      `INSERT INTO person_identity_evidence VALUES('manual',?,?,?,?, 'same','accepted','reviewed','manual','{}','2026-01-01')`,
    ).run(declarationSourceId(a), declarationSourceId(c), a.sourceHash, c.sourceHash);
    const repeat = run([group([a, b])]);
    assert.deepEqual([...repeat.assignments], [...first.assignments]);
    assert.equal(
      db.prepare("SELECT decision FROM person_identity_evidence WHERE id='manual'").get().decision,
      'revoked',
    );
    const changed = run([group([a, c], 'a'.repeat(64))]);
    assert.equal(changed.assignments.get(declarationSourceId(a)), id);
    assert.equal(changed.assignments.get(declarationSourceId(b)), legacy(b));
    assert.equal(changed.assignments.get(declarationSourceId(c)), id);
    assert.throws(
      () =>
        run([
          {
            ...group([a, b]),
            members: [
              { sourceId: declarationSourceId(a), sourceHash: '0'.repeat(64) },
              group([a, b]).members[1],
            ],
          },
        ]),
      /no longer matches/,
    );
    const noRegistry = run([group([b, c])]);
    assert.notEqual(noRegistry.assignments.get(declarationSourceId(b)), id);
    assert.equal(
      noRegistry.assignments.get(declarationSourceId(b)),
      noRegistry.assignments.get(declarationSourceId(c)),
    );
    assert.equal(noRegistry.assignments.get(declarationSourceId(b)), legacy(b));
    assert.equal(
      db.prepare('SELECT entity_id FROM person_sources WHERE id=?').get(declarationSourceId(b))
        .entity_id,
      null,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM person_identity_evidence WHERE rule_version='source-groups-1' AND decision='accepted'",
        )
        .get().n,
      1,
      'unanchored source grouping survives without inventing a separate person profile',
    );
    const anchoredChain = run([group([a, b]), group([b, c])]);
    assert.equal(anchoredChain.assignments.get(declarationSourceId(c)), id);
  } finally {
    db.close();
  }
});

test('conflicting identities in one listing group are quarantined, including ambiguous candidates', () => {
  const { db, filing, add, a, b, name, alias } = fixture();
  try {
    const one = filing('1.xml');
    add(b, name, '20240101120000');
    const ambiguous = filing('2.xml');
    const group = {
      folder: '2025',
      listHash: 'f'.repeat(64),
      personLocator: 1,
      name,
      members: [one, ambiguous].map((f) => ({
        sourceId: declarationSourceId(f),
        sourceHash: f.sourceHash,
      })),
    };
    const result = rebuildPersonEntities(db, db, [one, ambiguous], legacy, new Map(), undefined, [
      group,
    ]);
    assert.equal(result.stats.rejectedSourceGroups, 1);
    assert.equal(result.assignments.get(declarationSourceId(ambiguous)), legacy(ambiguous));
    // The pure component check also blocks a chain between independently accepted identities.
    const sources = [
      { id: 'd1', namespace: 'cacbg', source_hash: '1' },
      { id: 'd2', namespace: 'cacbg', source_hash: '2' },
      { id: 'tr1', namespace: 'tr', source_hash: a, source_key: a },
      { id: 'tr2', namespace: 'tr', source_hash: b, source_key: b },
    ];
    const edge = (l, r) => ({
      left_source: l.id,
      right_source: r.id,
      left_hash: l.source_hash,
      right_hash: r.source_hash,
      relation: 'same',
      decision: 'accepted',
      origin: 'automatic',
    });
    const components = identityComponents(sources, [
      edge(sources[0], sources[2]),
      edge(sources[1], sources[3]),
      edge(sources[0], sources[1]),
    ]);
    assert.equal(components.length, 4);
    assert.ok(components.every((c) => c.conflict));
  } finally {
    db.close();
  }
});
