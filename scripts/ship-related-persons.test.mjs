import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertShipFloor,
  parseMinLinks,
  resolveD1Name,
  insertStatements,
  sqlLiteral,
  sqlIdent,
  TABLES,
} from './ship-related-persons.mjs';

test('sqlLiteral escapes quotes, strips NUL, and NULLs non-finite/absent', () => {
  assert.equal(sqlLiteral(null), 'NULL');
  assert.equal(sqlLiteral(undefined), 'NULL');
  assert.equal(sqlLiteral(42), '42');
  assert.equal(sqlLiteral(Infinity), 'NULL');
  assert.equal(sqlLiteral(NaN), 'NULL');
  assert.equal(sqlLiteral("Д'Артанян"), "'Д''Артанян'"); // single quote doubled — injection-safe
  assert.equal(sqlLiteral('a\x00b'), "'ab'"); // NUL stripped
});

test('sqlIdent double-quotes and escapes identifiers', () => {
  assert.equal(sqlIdent('persons'), '"persons"');
  assert.equal(sqlIdent('we"ird'), '"we""ird"');
});

test('insertStatements builds a valid multi-row INSERT with escaped values', () => {
  const stmts = insertStatements(
    'persons',
    ['id', 'name'],
    [
      { id: 'person:a', name: 'Иван' },
      { id: 'person:b', name: "О'Брайън" },
    ],
  );
  assert.equal(stmts.length, 1);
  assert.match(stmts[0], /^INSERT INTO "persons" \("id", "name"\) VALUES\n/);
  assert.match(stmts[0], /\('person:a','Иван'\)/);
  assert.match(stmts[0], /\('person:b','О''Брайън'\)/); // escaped
  assert.match(stmts[0], /;\n$/);
});

test('insertStatements batches by row count (MAX_BATCH_ROWS)', () => {
  const rows = Array.from({ length: 900 }, (_, i) => ({ id: `p${i}`, name: `n${i}` }));
  const stmts = insertStatements('persons', ['id', 'name'], rows);
  // 900 rows / 400-row cap → 3 statements (400 + 400 + 100)
  assert.equal(stmts.length, 3);
  assert.ok(stmts.every((s) => s.startsWith('INSERT INTO "persons"')));
});

test('insertStatements yields nothing for empty columns or rows', () => {
  assert.deepEqual(insertStatements('persons', [], [{ id: 'x' }]), []);
  assert.deepEqual(insertStatements('persons', ['id'], []), []);
});

test('TABLES ships suppressions first and covers the served related-persons schema', () => {
  assert.equal(TABLES[0], 'link_suppressions'); // contested links never briefly re-exposed
  for (const t of [
    'persons',
    'declarations',
    'declared_interests',
    'interest_links',
    'interest_link_authorities',
  ]) {
    assert.ok(TABLES.includes(t), `missing ${t}`);
  }
});

test('assertShipFloor refuses to wipe the live surface below the floor (empty/partial staging)', () => {
  assert.throws(() => assertShipFloor(0, 50), /refusing to ship: 0 published links/); // the empty-wipe case
  assert.throws(() => assertShipFloor(49, 50), /< floor 50/);
  assert.doesNotThrow(() => assertShipFloor(50, 50)); // exactly at the floor is allowed
  assert.doesNotThrow(() => assertShipFloor(256, 50)); // healthy count
  assert.doesNotThrow(() => assertShipFloor(3, 3)); // an intentional small set via --min-links=3
  assert.throws(() => assertShipFloor(2, 3)); // …but one below it still refuses
});

test('parseMinLinks rejects the valueless-flag footgun and non-positive-integers', () => {
  // the footgun: a bare `--min-links` → arg() returns `true` → Number(true)=1 collapses the floor 50→1
  assert.throws(() => parseMinLinks(true), /requires a value/);
  assert.throws(() => parseMinLinks('abc'), /positive integer/); // non-numeric
  assert.throws(() => parseMinLinks('0'), /positive integer/); // zero disables the floor
  assert.throws(() => parseMinLinks('-5'), /positive integer/);
  assert.throws(() => parseMinLinks('2.5'), /positive integer/); // non-integer
  assert.equal(parseMinLinks(50), 50); // default (flag absent) passes through
  assert.equal(parseMinLinks('25'), 25); // --min-links=25
});

test('resolveD1Name refuses the prod default on a remote ship but keeps it for --local', () => {
  // The prod-wipe footgun: --remote with an unset SIGMA_D1_NAME must NOT silently fall back to 'sigma'.
  assert.throws(
    () => resolveD1Name({ remote: true, envName: undefined }),
    /must be set for a --remote/,
  );
  assert.throws(() => resolveD1Name({ remote: true, envName: '' }), /must be set for a --remote/);
  assert.equal(resolveD1Name({ remote: true, envName: 'sigma-stage' }), 'sigma-stage'); // explicit is fine
  assert.equal(resolveD1Name({ remote: false, envName: undefined }), 'sigma'); // --local has no blast radius
});

test('related_persons_internal (relative-name PII) is NOT shipped to the served D1', () => {
  // No served query reads it; shipping PII we never surface is a latent exposure. It stays in the
  // build/work DB only. If a real read path is ever added, ship it deliberately and revisit anonymization.
  assert.ok(!TABLES.includes('related_persons_internal'));
});
