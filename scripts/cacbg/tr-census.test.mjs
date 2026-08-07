// TR census — real data.egov.bg deed shape + deterministic tier-C promotion.
// Run: node --import ./scripts/cacbg/register-ts.mjs --test scripts/cacbg/tr-census.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractEntity, buildCensus, promote } from './tr-census.mjs';
const { companyNameKey } = await import('../../packages/shared/src/company-name-key.ts');

let dir, dump, dbPath;
const K = (s) => companyNameKey(s);

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-census-'));
  dump = path.join(dir, 'tr.json');
  // Real export shape: Message[].Body[].Deeds[].Deed[], each with its fields under `$`; CompanyName is
  // bare and LegalForm is a code — the census must reconstruct «name + Bulgarian form» to match bidders.
  const deeds = [
    { CompanyName: 'СИЙ', LegalForm: 'AD', UIC: '444444447' }, // globally unique → promote
    { CompanyName: 'ОБЩА ФИРМА', LegalForm: 'OOD', UIC: '555555556' }, // one of two namesakes
    { CompanyName: 'Обща Фирма', LegalForm: 'OOD', UIC: '666666663' }, // second namesake → NOT unique
    { CompanyName: 'СИЙ', LegalForm: 'AD', UIC: '444444447' }, // same deed on another day → deduped
  ];
  fs.writeFileSync(
    dump,
    JSON.stringify({ Message: [{ Body: [{ Deeds: [{ Deed: deeds.map((d) => ({ $: d })) }] }] }] }),
  );

  dbPath = path.join(dir, 'db.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE interest_links(link_key TEXT PRIMARY KEY, eik TEXT, entity_key TEXT, status TEXT, publish_tier TEXT, match_method TEXT);
    INSERT INTO interest_links VALUES ('p1|444444447','444444447','${K('СИЙ АД')}','held','C_hold','exact_name_key');
    INSERT INTO interest_links VALUES ('p2|555555556','555555556','${K('ОБЩА ФИРМА ООД')}','held','C_hold','exact_name_key');
  `);
  db.close();
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('extractEntity reconstructs «name + Bulgarian legal form» from a TR deed and reads UIC as ЕИК', () => {
  assert.deepEqual(extractEntity({ CompanyName: 'СИЙ', LegalForm: 'AD', UIC: '444444447' }), {
    eik: '444444447',
    name: 'СИЙ АД',
  });
  assert.deepEqual(extractEntity({ CompanyName: 'ТЕСТ', LegalForm: 'EOOD', UIC: '205057459' }), {
    eik: '205057459',
    name: 'ТЕСТ ЕООД',
  });
  assert.equal(extractEntity({ CompanyName: 'X', LegalForm: 'AD', UIC: '2018060520' }).eik, null); // 10 digits ≠ ЕИК
  assert.equal(extractEntity({ name: 'flat ООД', uic: '5555555560000' }).eik, '5555555560000'); // flat fallback + 13-digit
});

test('buildCensus indexes name-key → set of ЕИК over the nested export (dedup by ЕИК)', () => {
  const c = buildCensus(dump);
  assert.equal(c.get(K('СИЙ АД')).size, 1); // appears twice, one ЕИК → deduped
  assert.equal(c.get(K('ОБЩА ФИРМА ООД')).size, 2); // two distinct ЕИК fold to one key → non-unique
});

test('promote publishes only globally-unique tier-C links; shared names stay held', () => {
  const db = new DatabaseSync(dbPath);
  // census covers 3 distinct ЕИК → assert coverage with --min-eik 3 (the partial-census gate).
  const res = promote(db, buildCensus(dump), { minEik: 3 });
  assert.equal(res.promoted, 1);
  const rows = new Map(
    db
      .prepare('SELECT link_key,status,match_method FROM interest_links')
      .all()
      .map((r) => [r.link_key, r]),
  );
  assert.equal(rows.get('p1|444444447').status, 'published');
  assert.match(rows.get('p1|444444447').match_method, /tr_census/);
  assert.equal(rows.get('p2|555555556').status, 'held'); // two namesakes → stays held
  db.close();
});

test('partial-census gate: a real promote refuses without --min-eik, and when coverage is below it', () => {
  const db = new DatabaseSync(dbPath);
  // isolate: p1 back to held (an earlier test may have published it — shared dbPath)
  db.exec(
    "UPDATE interest_links SET status='held', match_method='exact_name_key' WHERE link_key='p1|444444447'",
  );
  const census = buildCensus(dump); // 3 distinct ЕИК
  // no --min-eik → refuse (can't assert completeness → could fabricate a false-unique attribution)
  assert.throws(() => promote(db, census, {}), /--min-eik/);
  // --min-eik above the census's coverage → refuse (partial dump)
  assert.throws(() => promote(db, census, { minEik: 4 }), /partial census|distinct ЕИК/);
  // the refused runs published nothing — p1 is still held
  assert.equal(
    db.prepare("SELECT status FROM interest_links WHERE link_key='p1|444444447'").get().status,
    'held',
  );
  db.close();
});

test('partial-census gate: --force-partial is the explicit override', () => {
  const db = new DatabaseSync(dbPath);
  db.exec(
    "UPDATE interest_links SET status='held', match_method='exact_name_key' WHERE link_key='p1|444444447'",
  );
  const res = promote(db, buildCensus(dump), { forcePartial: true }); // no minEik, but forced
  assert.equal(res.promoted, 1);
  db.close();
});

test('dry-run reports would-promote set without mutating the DB', () => {
  const db = new DatabaseSync(dbPath);
  // reset p1 back to held for an isolated dry-run check
  db.exec(
    "UPDATE interest_links SET status='held', match_method='exact_name_key' WHERE link_key='p1|444444447'",
  );
  const res = promote(db, buildCensus(dump), { dryRun: true });
  assert.deepEqual(res.would, ['p1|444444447']);
  assert.equal(
    db.prepare("SELECT status FROM interest_links WHERE link_key='p1|444444447'").get().status,
    'held',
  ); // untouched
  db.close();
});
