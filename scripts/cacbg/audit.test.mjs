// audit.mjs is the independent libel gate over PUBLISHED interest_links. ADR-0028 made declared_eik
// links publish as tier A_eik — deterministic by the declarant-provided ЕИК, even behind a name shared by
// >1 winner. The gate's invariant A ("the name key resolves to EXACTLY ONE valid ЕИК") is legitimately
// violated by such a link, so for A_eik it is REPLACED by two checks that keep the gate just as strong:
//   A_eik_not_winner    — the published ЕИК must be a valid winner BEARING that name-key (not a stray ЕИК).
//   A_eik_no_provenance — a declaration by the person must carry that ЕИК AND the winner name (the
//                         double-lock load.mjs required) — re-proven here so a loader bug can't smuggle a
//                         fabricated attach past the gate.
// These tests pin: (1) a colliding-name A_eik link with a real double-lock PASSES (was a false A_multi_eik);
// (2) a stray-ЕИК A_eik link is caught; (3) a provenance-less A_eik link is caught; (4) a NON-A_eik
// (name-based) colliding link STILL fails A_multi_eik — the relaxation must not weaken the name gate.
// Run: node --import ./scripts/cacbg/register-ts.mjs --test scripts/cacbg/audit.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const { companyNameKey: K } = await import('../../packages/shared/src/company-name-key.ts');
const dirs = [];

// Build a fixture DB (bidders + declarations + declared_interests + interest_links), run audit.mjs against
// it as a subprocess, and return { threw, out } — threw=true iff the audit exited non-zero (a hard finding).
function buildAndAudit({ bidders, decls = [], dis = [], links }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-audit-'));
  dirs.push(dir);
  const DB = path.join(dir, 'fixture.sqlite');
  const db = new DatabaseSync(DB);
  db.exec(`
    CREATE TABLE bidders(id TEXT PRIMARY KEY, name TEXT, eik_normalized TEXT, eik_valid INT);
    CREATE TABLE declarations(id TEXT PRIMARY KEY, person_id TEXT);
    CREATE TABLE declared_interests(id INTEGER PRIMARY KEY, declaration_id TEXT, entity_raw TEXT);
    CREATE TABLE interest_links(
      id TEXT PRIMARY KEY, link_key TEXT, person_id TEXT, eik TEXT, entity_key TEXT, match_method TEXT,
      publish_tier TEXT, bidder_id TEXT, relation TEXT, contemporaneous INT, contract_value_eur REAL, status TEXT);
    ${bidders.map((b) => `INSERT INTO bidders VALUES (${b});`).join('\n')}
    ${decls.map((d) => `INSERT INTO declarations VALUES (${d});`).join('\n')}
    ${dis.map((d) => `INSERT INTO declared_interests(declaration_id, entity_raw) VALUES (${d});`).join('\n')}
    ${links.map((l) => `INSERT INTO interest_links VALUES (${l});`).join('\n')}
  `);
  db.close();

  let threw = false;
  let out = '';
  try {
    out = execFileSync(
      'node',
      ['--import', path.join(HERE, 'register-ts.mjs'), path.join(HERE, 'audit.mjs')],
      { cwd: ROOT, env: { ...process.env, CACBG_DB: DB }, encoding: 'utf8', stdio: 'pipe' },
    );
  } catch (e) {
    threw = true; // execFileSync throws on non-zero exit (a hard finding fired)
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  return { threw, out };
}

after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// Two real winners fold to the same name key but carry distinct valid ЕИК → the "colliding name" case.
const COLLIDING_BIDDERS = [`'b1','„ОБЩ" ЕООД','100000001',1`, `'b2','ОБЩ ЕООД','200000002',1`];
const KEY = K('„ОБЩ" ЕООД'); // == K('ОБЩ ЕООД') — the shared key both winners map to

test('A_eik behind a colliding name, backed by a real ЕИК+name double-lock, PASSES the gate', () => {
  const { threw, out } = buildAndAudit({
    bidders: COLLIDING_BIDDERS,
    decls: [`'d1','p1'`],
    // the declarant wrote BOTH the ЕИК and the фирма → the double-lock the loader required
    dis: [`'d1','„ОБЩ" ЕООД, ЕИК 100000001'`],
    links: [
      `'il1','p1|100000001','p1','100000001','${KEY}','declared_eik','A_eik','b1','owns',0,1000,'published'`,
    ],
  });
  assert.equal(
    threw,
    false,
    'a valid A_eik link must not fail the gate — the ЕИК disambiguates the collision',
  );
  assert.equal(/A_multi_eik/.test(out), false, 'the old single-ЕИК rule must not fire for A_eik');
  assert.equal(/hard findings: 0/.test(out), true, 'zero hard findings expected');
});

test('A_eik published on a ЕИК that is NOT a winner bearing the name key → A_eik_not_winner (hard)', () => {
  const { threw, out } = buildAndAudit({
    // b3 is a valid bidder, but its name folds to a DIFFERENT key — so 300000003 is not among KEY's winners
    bidders: [...COLLIDING_BIDDERS, `'b3','ДРУГ ЕООД','300000003',1`],
    decls: [`'d1','p1'`],
    dis: [`'d1','„ОБЩ" ЕООД, ЕИК 300000003'`],
    // entity_key claims the colliding name, but the published eik/bidder is the unrelated 300000003
    links: [
      `'il1','p1|300000003','p1','300000003','${KEY}','declared_eik','A_eik','b3','owns',0,1000,'published'`,
    ],
  });
  assert.equal(threw, true, 'a stray-ЕИК A_eik link must fail the gate');
  assert.equal(
    /A_eik_not_winner/.test(out),
    true,
    'the published ЕИК is not a winner for this name key',
  );
});

test('A_eik with no declaration carrying its ЕИК+name → A_eik_no_provenance (hard)', () => {
  const { threw, out } = buildAndAudit({
    bidders: [`'b1','„ОБЩ" ЕООД','100000001',1`], // single winner: old invariant A would have passed
    decls: [`'d1','p1'`],
    dis: [`'d1','нещо съвсем друго без ЕИК'`], // no ЕИК, no фирма → the double-lock cannot be re-proven
    links: [
      `'il1','p1|100000001','p1','100000001','${K('„ОБЩ" ЕООД')}','declared_eik','A_eik','b1','owns',0,1000,'published'`,
    ],
  });
  assert.equal(
    threw,
    true,
    'an A_eik link whose double-lock cannot be re-proven must fail the gate',
  );
  assert.equal(
    /A_eik_no_provenance/.test(out),
    true,
    'the ЕИК+name double-lock is missing from any declaration',
  );
});

test('a NON-A_eik (name-based) colliding link STILL fails A_multi_eik — the name gate is untouched', () => {
  const { threw, out } = buildAndAudit({
    bidders: COLLIDING_BIDDERS,
    // exact_name_key published on a name that maps to 2 ЕИК — exactly what the gate must keep rejecting
    links: [
      `'il1','p1|100000001','p1','100000001','${KEY}','exact_name_key','B_distinctive','b1','owns',0,1000,'published'`,
    ],
  });
  assert.equal(threw, true, 'a name-based colliding published link must still fail');
  assert.equal(/A_multi_eik/.test(out), true, 'invariant A still fires for non-A_eik links');
});
