import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { PUBLIC_BODIES, seedSql } from './appk-public-enterprises.mjs';

const seed = readFileSync(new URL('./seed-state-owned.sql', import.meta.url), 'utf8');

// The Agency's list is regenerated whenever the agency publishes a new one, and it carries public
// ENTERPRISES only — so every regeneration silently drops the bodies created by law (a university, a
// BAN institute, a national broadcaster, a state agency), which have no Trade Register partida either.
// That is not cosmetic: without `ownership_kind` a declared MANAGEMENT role in one of them stops being
// ex-officio and surfaces as a PRIVATE interest in a state body. This pins them to the generated file.
test('the seed keeps the public bodies no source of its own reaches', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(seed);
    const kindOf = db.prepare('SELECT ownership_kind k FROM state_owned_eik WHERE eik = ?');
    for (const [eik, kind, name] of PUBLIC_BODIES)
      assert.equal(kindOf.get(eik)?.k, kind, `${name} (${eik})`);
    // The enterprises from the list are still there beside them.
    const { n } = db.prepare('SELECT COUNT(*) n FROM state_owned_eik').get();
    assert.ok(n > PUBLIC_BODIES.length + 100, `only ${n} rows in the seed`);
  } finally {
    db.close();
  }
});

test('a regenerated seed carries the same bodies, after the list’s own entries', () => {
  const sql = seedSql({
    date: '01.01.2026',
    rows: [{ eik: '123456789', principal: 'МИНИСТЕРСТВО НА ТЕСТОВЕТЕ', name: '„Тест Груп“ ЕАД' }],
  });
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(sql);
    for (const [eik, kind] of PUBLIC_BODIES)
      assert.equal(
        db.prepare('SELECT ownership_kind k FROM state_owned_eik WHERE eik = ?').get(eik)?.k,
        kind,
      );
    assert.equal(
      db.prepare("SELECT canonical_name n FROM state_owned_eik WHERE eik = '123456789'").get()?.n,
      '„Тест Груп“ ЕАД',
    );
  } finally {
    db.close();
  }
});
