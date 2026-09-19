import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declarantGuid, declarantGuidEvidence, DECLARANT_GUID_RULE } from './declarant-guid.mjs';

const G = '0008C66A-3C73-47DF-9135-A095CAC6EA07';
const doc = (folder, xmlFile, person, sourceHash = 'e'.repeat(64)) => ({
  folder,
  xmlFile,
  person,
  sourceHash,
});

test('reads the declarant GUID only from numbered file names', () => {
  assert.equal(declarantGuid(`${G.toLowerCase()}72887.xml`), G);
  assert.equal(declarantGuid(`${G}.xml`), null);
  assert.equal(declarantGuid('list.xml'), null);
  assert.equal(declarantGuid(undefined), null);
});

test('chains one declarant across folders and institutions in a stable order', () => {
  const a = doc('2024', `${G}1.xml`, 'Ивана Петрова Тестова');
  const b = doc('2025', `${G}2.xml`, 'Ивана Петрова Тестова', 'f'.repeat(64));
  const c = doc('2026', `${G}3.xml`, 'Ивана Петрова Тестова');
  const edges = declarantGuidEvidence([c, a, b]);
  const byLeft = (x, y) => x[0].localeCompare(y[0]);
  assert.deepEqual(
    edges.map((e) => [e.left_source, e.right_source, e.left_hash, e.right_hash]).sort(byLeft),
    [
      [`cacbg:2024:${G}1.xml`, `cacbg:2025:${G}2.xml`, a.sourceHash, b.sourceHash],
      [`cacbg:2025:${G}2.xml`, `cacbg:2026:${G}3.xml`, b.sourceHash, c.sourceHash],
    ],
  );
  assert.ok(edges.every((e) => e.rule_version === DECLARANT_GUID_RULE && e.relation === 'same'));
  assert.deepEqual(declarantGuidEvidence([a, b, c]), edges);
  assert.deepEqual(JSON.parse(edges[0].facts).documents[0], {
    id: edges[0].left_source,
    name: 'ИВАНА ПЕТРОВА ТЕСТОВА',
  });
});

test('a changed family name stays one declarant when the GUID knows no other person', () => {
  const edges = declarantGuidEvidence([
    doc('2024', `${G}1.xml`, 'Ивана Петрова Тестова'),
    doc('2025', `${G}2.xml`, 'Ивана Петрова Примерова'),
  ]);
  assert.equal(edges.length, 1);
});

test('a GUID shared by unrelated names links identical names only', () => {
  const edges = declarantGuidEvidence([
    doc('2015', `${G}1.xml`, 'Ивана Петрова Тестова'),
    doc('2015', `${G}2.xml`, 'Георги Иванов Примеров'),
    doc('2015', `${G}3.xml`, 'Ивана Петрова Примерова'),
    doc('2016', `${G}4.xml`, 'Георги Иванов Примеров'),
  ]);
  assert.deepEqual(
    edges.map((e) => [e.left_source, e.right_source]),
    [[`cacbg:2015:${G}2.xml`, `cacbg:2016:${G}4.xml`]],
  );
});

test('a GUID per document and different GUIDs never link', () => {
  assert.deepEqual(
    declarantGuidEvidence([
      doc('2023f1', `${G}.xml`, 'Ивана Петрова Тестова'),
      doc('2024f1', `${G}.xml`, 'Ивана Петрова Тестова'),
      doc('2025', `${G.replace('0008', '1008')}1.xml`, 'Ивана Петрова Тестова'),
      doc('2025', `${G}1.xml`, ''),
    ]),
    [],
  );
});

// The GUID is the register's own id for a declarant; the name only guards against the register reusing
// one. Demanding identical names split a real declarant in two over a single typed letter — same GUID,
// same council, same years — and left his registry roles on only one of the halves.
test('one typed slip under a shared GUID is still one declarant', () => {
  const guid = 'B35A651B-D353-424E-875C-573B058D3016';
  const doc = (n, person) => ({
    xmlFile: `${guid}${n}.xml`,
    folder: '2023y2',
    person,
    sourceHash: `h${n}`,
  });
  const edges = declarantGuidEvidence([
    doc('100001', 'Стоян Великов Примеров'),
    doc('100002', 'Стоян Велинов Примеров'),
  ]);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].rule_version, DECLARANT_GUID_RULE);

  // Two letters apart is no longer a slip: the chains stay separate, so no edge is proposed at all.
  assert.equal(
    declarantGuidEvidence([doc('1', 'Иван Петров Георгиев'), doc('2', 'Иван Петкав Георгиев')])
      .length,
    0,
  );
  // And a GUID the register reused for somebody else links nothing.
  assert.equal(
    declarantGuidEvidence([doc('1', 'Иван Петров Георгиев'), doc('2', 'Мария Стоянова Димитрова')])
      .length,
    0,
  );
});
