import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

test('extraction keeps checksum collisions, deduplicates identical XML and isolates listing conflicts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-source-identity-'));
  const raw = path.join(dir, 'raw');
  const staging = path.join(dir, 'staging');
  const folder = path.join(raw, '2025');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(raw, '.corpus-complete.json'), '{}');
  const xml = (
    name,
    hash,
  ) => `<PublicPerson><Personal><Name>${name}</Name><Work>Тест институция</Work><Position>Главен архитект</Position></Personal>
    <DeclarationData><Year>2025</Year><ControlHash>${hash}</ControlHash><DeclarationType>Vacate</DeclarationType><ActNumber>201</ActNumber><ActData>21.12.</ActData></DeclarationData>
    <Tables><Table Num="10" Declared="False" Description="Дялове в дружества с ограничена отговорност">
    <Row><Cell Num="4" Description="Наименование на дружеството"/><Cell Num="7" Description="Име собствено бащино фамилно"/></Row></Table></Tables></PublicPerson>`;
  const a = 'Иван Петров Тестов';
  const b = 'Георги Николов Примеров';
  const docs = [
    ['aa.xml', a, xml(a, 'Неуспешна Валидация')],
    ['bb.xml', b, xml(b, 'Неуспешна Валидация')],
    ['cc.xml', a, xml(a, 'DEADBEEF')],
    ['dd.xml', b, xml(b, 'DEADBEEF')],
    ['ee.xml', a, xml(a, 'DEADBEEF')], // identical publication
    ['ff.xml', b, xml(a, '12345678')], // wrong listing must not steal the declaration
    ['gg.xml', a, xml(a, '12345678')], // valid later copy remains eligible
  ];
  fs.writeFileSync(
    path.join(folder, 'list.xml'),
    `<root><MainCategory><Category Name="Годишни"><Institution Name="Тест институция">${docs
      .map(
        ([file, name]) =>
          `<Person><Name>${name}</Name><Position><Name>Директор</Name><Declaration><xmlFile>${file}</xmlFile></Declaration></Position></Person>`,
      )
      .join('')}</Institution></Category></MainCategory></root>`,
  );
  for (const [file, , content] of docs) fs.writeFileSync(path.join(folder, file), content);
  try {
    execFileSync(process.execPath, ['scripts/cacbg/extract.mjs'], {
      env: { ...process.env, CACBG_RAW: raw, CACBG_STAGING: staging },
      stdio: 'pipe',
    });
    const read = (file) =>
      fs
        .readFileSync(path.join(staging, file), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse);
    const filings = read('filings.jsonl');
    assert.deepEqual(filings.map((f) => f.xmlFile).sort(), [
      'aa.xml',
      'bb.xml',
      'cc.xml',
      'dd.xml',
      'gg.xml',
    ]);
    assert.equal(filings.find((f) => f.xmlFile === 'gg.xml').person, a);
    assert.ok(filings.every((f) => f.assetInventoryComparable === true));
    assert.ok(
      filings.every((f) => f.position === 'Директор' && f.declaredPosition === 'Главен архитект'),
    );
    assert.ok(
      filings.every((f) => f.appointmentNumber === '201' && f.appointmentDate === '21.12.'),
    );
    assert.deepEqual(read('source-quarantine.jsonl'), [
      { folder: '2025', xmlFile: 'ff.xml', reason: 'declarant_mismatch' },
    ]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'))).schemaVersion, 8);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'))).filingsHash,
      createHash('sha256')
        .update(fs.readFileSync(path.join(staging, 'filings.jsonl')))
        .digest('hex'),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listing topology survives identical republications, but never names, filenames or invalid members', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-listing-groups-'));
  const raw = path.join(dir, 'raw'),
    staging = path.join(dir, 'staging');
  fs.mkdirSync(raw);
  fs.writeFileSync(path.join(raw, '.corpus-complete.json'), '{}');
  const name = 'Иван Петров Тестов';
  const xml = (n, v) =>
    `<PublicPerson><Personal><Name>${n}</Name></Personal><DeclarationData><Year>2025</Year><ControlHash>${v}</ControlHash></DeclarationData></PublicPerson>`;
  const a = xml(name, 'a'),
    b = xml(name, 'b'),
    c = xml(name, 'c');
  const create = (folder, groups, docs) => {
    const d = path.join(raw, folder);
    fs.mkdirSync(d);
    fs.writeFileSync(
      path.join(d, 'list.xml'),
      `<root><MainCategory><Category><Institution>${groups.map((files) => `<Person><Name>${name}</Name><Position>${files.map((f) => `<Declaration><xmlFile>${f}</xmlFile></Declaration>`).join('')}</Position></Person>`).join('')}</Institution></Category></MainCategory></root>`,
    );
    for (const [f, content] of Object.entries(docs)) fs.writeFileSync(path.join(d, f), content);
  };
  create('2025', [['aa.xml', 'bb.xml'], ['alone.xml']], {
    'aa.xml': a,
    'bb.xml': b,
    'alone.xml': xml(name, 'separate'),
  });
  create(
    '2025y',
    [
      ['copy.xml', 'cc.xml'],
      ['dd.xml', 'wrong.xml'],
    ],
    {
      'copy.xml': b,
      'cc.xml': c,
      'dd.xml': xml(name, 'd'),
      'wrong.xml': xml('Георги Петров Другов', 'wrong'),
    },
  );
  create('2026', [['aa.xml', 'ee.xml']], {
    'aa.xml': xml(name, 'different bytes'),
    'ee.xml': xml(name, 'e'),
  });
  try {
    execFileSync(process.execPath, ['scripts/cacbg/extract.mjs'], {
      env: { ...process.env, CACBG_RAW: raw, CACBG_STAGING: staging },
      stdio: 'pipe',
    });
    const groups = fs
      .readFileSync(path.join(staging, 'source-groups.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(groups.length, 3);
    assert.deepEqual(
      groups[0].members.map((m) => m.sourceId),
      ['cacbg:2025:aa.xml', 'cacbg:2025:bb.xml'],
    );
    assert.deepEqual(
      groups[1].members.map((m) => m.sourceId),
      ['cacbg:2025:bb.xml', 'cacbg:2025y:cc.xml'],
    );
    assert.equal(groups[1].members[0].xmlFile, 'copy.xml');
    assert.ok(groups[2].members.every((m) => m.sourceId.startsWith('cacbg:2026:')));
    assert.ok(groups.every((g) => /^[a-f0-9]{64}$/.test(g.listHash) && g.personLocator === 1));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
