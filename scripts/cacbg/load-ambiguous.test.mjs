// The load-time "libel gate" (previously `trueOverMerge_LIBEL_GATE`) was a structural false-zero: it
// tiebroke a multi-ЕИК bucket on a `strictKey` that stripped MORE than companyNameKey (whitespace +
// quotes + .,-), so any two names already sharing a companyNameKey necessarily shared a strictKey — the
// second clause could never be true, the counter was hardwired to 0, yet the loader printed
// „✓ libel gate: 0 over-merges" and was wired to exit(1) on it (review #226, ADR-0027). That asserted a
// measured proof it did not have. The honest replacement: report keys that map to >1 distinct valid
// winner ЕИК as TELEMETRY (the resolver already quarantines them at load.mjs — they never publish, so no
// libel exposure), tied to NO exit code. The real 0-over-merge proof is the LABELLED
// company-name-key.test.ts (ground-truth companyId), which a self-comparison of the winner set cannot
// reproduce. These tests pin: (1) an ambiguous key does NOT hard-fail the load; (2) it IS counted and
// surfaced honestly where strictKey reported 0; (3) the misleading gate field is gone.
// Run: node --import ./scripts/cacbg/register-ts.mjs --test scripts/cacbg/load-ambiguous.test.mjs
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
const dirs = [];

// Build a bidder-only fixture, run the loader against it, and return { threw, S } where S is the parsed
// report summary. Empty holdings/related — the ambiguity metric is computed purely over the bidder set,
// so no declarations are needed to exercise it.
function buildAndLoad(bidderRows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-ambig-'));
  dirs.push(dir);
  const DB = path.join(dir, 'fixture.sqlite');
  const STAGING = path.join(dir, 'staging');
  fs.mkdirSync(STAGING, { recursive: true });

  const db = new DatabaseSync(DB);
  db.exec(`
    CREATE TABLE bidders(id TEXT PRIMARY KEY, name TEXT, eik_normalized TEXT, eik_valid INT, settlement TEXT);
    CREATE TABLE authorities(id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE tenders(id TEXT PRIMARY KEY, authority_id TEXT);
    CREATE TABLE contracts(id TEXT PRIMARY KEY, tender_id TEXT, bidder_id TEXT, signed_at TEXT, amount_eur REAL);
    ${bidderRows.map((r) => `INSERT INTO bidders VALUES (${r});`).join('\n')}
  `);
  db.close();
  fs.writeFileSync(path.join(STAGING, 'holdings.jsonl'), '');
  fs.writeFileSync(path.join(STAGING, 'related.jsonl'), '');

  let threw = false;
  try {
    execFileSync(
      'node',
      ['--import', path.join(HERE, 'register-ts.mjs'), path.join(HERE, 'load.mjs')],
      { cwd: ROOT, env: { ...process.env, CACBG_DB: DB, CACBG_STAGING: STAGING }, stdio: 'pipe' },
    );
  } catch {
    threw = true; // execFileSync throws on a non-zero exit code (a fired hard-gate)
  }
  const md = fs.readFileSync(path.join(STAGING, 'findings.md'), 'utf8');
  const S = JSON.parse(md.split('```json')[1].split('```')[0]);
  return { threw, S };
}

after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test('an ambiguous key (>1 valid ЕИК, presentation-variant names) is reported, never hard-fails, and the old false gate is gone', () => {
  // „АЛФА" ЕООД and АЛФА ЕООД fold to the same companyNameKey (quotes → space) but carry two distinct
  // valid ЕИК — the exact shape strictKey collapsed to a false zero. БЕТА ЕООД is an unambiguous control.
  const { threw, S } = buildAndLoad([
    `'eik:100000001','„АЛФА" ЕООД','100000001',1,'София'`,
    `'eik:200000002','АЛФА ЕООД','200000002',1,'Пловдив'`,
    `'eik:300000003','БЕТА ЕООД','300000003',1,'Варна'`,
  ]);

  // (1) Ambiguity is EXPECTED and quarantined — it must NOT fail the load (guards against a hard gate
  //     that would falsely block the GitOps pipeline on benign feed-dupes / generic names).
  assert.equal(threw, false, 'an ambiguous (quarantined) key must not hard-fail the loader');

  // (2) The honest telemetry exists and counts exactly the one ambiguous bucket — where the old
  //     strictKey gate reported 0.
  assert.equal(
    typeof S.ambiguous_name_keys,
    'number',
    'report exposes an honest ambiguous-key count',
  );
  assert.equal(S.ambiguous_name_keys, 1, 'exactly the „АЛФА" bucket is ambiguous; БЕТА is not');

  // (3) Full transparency: the ambiguous bucket is surfaced with its key and BOTH ЕИК + raw names.
  const ex = (S.ambiguous_name_key_examples ?? []).find((e) => e.key === 'АЛФА ЕООД');
  assert.ok(ex, 'the ambiguous bucket is listed as a worked example');
  assert.deepEqual([...ex.eiks].sort(), ['100000001', '200000002']);
  assert.equal(new Set(ex.names).size, 2, 'both raw name variants are shown');

  // (4) The misleading „measured 0 over-merges" claim is removed — no false proof left in the report.
  assert.equal(S.trueOverMerge_LIBEL_GATE, undefined, 'the false strictKey gate field is gone');
});

test('a clean bidder set (all single-ЕИК keys) reports zero ambiguous keys and succeeds', () => {
  const { threw, S } = buildAndLoad([
    `'eik:400000004','ГАМА ЕООД','400000004',1,'София'`,
    `'eik:500000005','ДЕЛТА ЕООД','500000005',1,'Пловдив'`,
  ]);
  assert.equal(threw, false);
  assert.equal(
    S.ambiguous_name_keys,
    0,
    'no ambiguity → count is a truthful 0, not a structural one',
  );
  assert.deepEqual(S.ambiguous_name_key_examples ?? [], []);
});
