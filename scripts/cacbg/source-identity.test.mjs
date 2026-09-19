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
  for (const other of ['Иван Тестов', 'И. П. Тестов', 'Георги Петров Тестов'])
    assert.equal(declarationAttribution(name, [other]), 'declarant_mismatch');
  assert.equal(
    declarationAttribution(name, [name, 'Георги Николов Примеров']),
    'ambiguous_listing',
  );
  assert.equal(declarationAttribution(name, []), 'unlisted_document');
  assert.equal(declarationAttribution('', [name]), 'missing_declarant');
});

// The register writes the same person's name two ways — one spelling in its listing, another inside the
// document. Byte equality threw 2.6% of the 2026 set away, ministers and MPs among them, so a title and
// the register's own slips are accepted as a variant — but as their OWN verdict, never as an exact match.
test('a title or the register’s own slip is a name variant, not a foreign declarant', () => {
  const name = 'Иван Петров Тестов';
  // A title is presentation on one side only: still an exact match, not a variant.
  for (const titled of [
    'д-р Иван Петров Тестов',
    'Д-Р ИВАН ПЕТРОВ ТЕСТОВ',
    'проф. д-р Иван Петров Тестов',
  ])
    assert.equal(declarationAttribution(titled, [name]), 'matched');

  for (const [declarant, listed] of [
    ['Иван Петров Тестев', 'Иван Петров Тестов'], // one mistyped letter in the surname
    ['Иван Петрвов Тестов', 'Иван Петров Тестов'], // two adjacent letters swapped
    ['Иван Петров Тесстов', 'Иван Петров Тестов'], // one letter too many
  ]) {
    assert.equal(declarationAttribution(declarant, [listed]), 'name_variant');
    assert.equal(declarationAttribution(listed, [declarant]), 'name_variant');
  }

  // The rails still hold. A NAME CHANGE is not a slip: only the Trade Register may establish that two
  // names are one person, and the registry resolver answers that before this ever runs (ADR-0033).
  for (const other of [
    'Ивана Петрова Тестова-Примерова', // a second surname on one side only
    'Ивана Петрова Примерова', // a surname taken on marriage
    'Георги Николов Примеров',
    'Петър Иванов Тестов',
    'Иван Георгиев Примеров',
    'Иван Петров Васасилев', // two letters apart is no longer one slip
  ])
    assert.equal(
      declarationAttribution(other === 'Ивана Петрова Примерова' ? 'Ивана Петрова Тестова' : name, [
        other,
      ]),
      'declarant_mismatch',
    );
});
