import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

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
  ) => `<PublicPerson><Personal><Name>${name}</Name><Work>Тест институция</Work></Personal>
    <DeclarationData><Year>2025</Year><ControlHash>${hash}</ControlHash><DeclarationType>Annualy</DeclarationType></DeclarationData>
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
    assert.deepEqual(read('source-quarantine.jsonl'), [
      { folder: '2025', xmlFile: 'ff.xml', reason: 'declarant_mismatch' },
    ]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'))).schemaVersion, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
