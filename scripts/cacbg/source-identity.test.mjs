import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentFingerprint, declarationAttribution } from './source-identity.mjs';

test('source checksum collisions and validation errors cannot erase distinct documents', () => {
  for (const hash of ['DEADBEEF', 'Неуспешна Валидация', '']) {
    const a = `<root><Name>Иван Петров Тестов</Name><ControlHash>${hash}</ControlHash></root>`;
    const b = a.replace('Иван Петров Тестов', 'Георги Николов Примеров');
    assert.notEqual(documentFingerprint(a), documentFingerprint(b));
    assert.equal(documentFingerprint(a), documentFingerprint(a));
    assert.notEqual(
      documentFingerprint(a),
      documentFingerprint(a.replace('</root>', '<Correction>1</Correction></root>')),
    );
  }
});

test('attribution requires the same complete name in document and listing', () => {
  const name = 'Иван Петров Тестов';
  assert.equal(declarationAttribution(name, ['  ИВАН  ПЕТРОВ ТЕСТОВ  ']), 'matched');
  assert.equal(
    declarationAttribution('Ивана Петрова Тестова-Примерова', [
      'Ивана Петрова Тестова - Примерова',
    ]),
    'matched',
  );
  for (const other of ['Иван Тестов', 'И. П. Тестов', 'Иван Петров Тестев', 'Георги Петров Тестов'])
    assert.equal(declarationAttribution(name, [other]), 'declarant_mismatch');
  assert.equal(
    declarationAttribution(name, [name, 'Георги Николов Примеров']),
    'ambiguous_listing',
  );
  assert.equal(declarationAttribution(name, []), 'unlisted_document');
  assert.equal(declarationAttribution('', [name]), 'missing_declarant');
});
