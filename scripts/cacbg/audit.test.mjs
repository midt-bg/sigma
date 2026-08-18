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
function buildAndAudit({ bidders, decls = [], dis = [], links, seals = [], snapshot = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacbg-audit-'));
  dirs.push(dir);
  const DB = path.join(dir, 'fixture.sqlite');
  const staging = path.join(dir, 'staging');
  fs.mkdirSync(staging, { recursive: true });
  // The pre-wipe export load.mjs writes before it drops the CACBG tables. Absent === a first run.
  if (snapshot)
    fs.writeFileSync(path.join(staging, 'published-snapshot.json'), JSON.stringify(snapshot));
  const db = new DatabaseSync(DB);
  db.exec(`
    CREATE TABLE bidders(id TEXT PRIMARY KEY, name TEXT, eik_normalized TEXT, eik_valid INT);
    CREATE TABLE declarations(id TEXT PRIMARY KEY, person_id TEXT);
    CREATE TABLE declared_interests(id INTEGER PRIMARY KEY, declaration_id TEXT, entity_raw TEXT);
    CREATE TABLE interest_links(
      id TEXT PRIMARY KEY, link_key TEXT, person_id TEXT, eik TEXT, entity_key TEXT, match_method TEXT,
      publish_tier TEXT, bidder_id TEXT, relation TEXT, contemporaneous INT, contract_value_eur REAL, status TEXT);
    -- The evidence seal (#279, migration 0006). The audit LEFT JOINs it, so it must exist even when a
    -- case deliberately leaves a link unsealed — an unsealed published link is itself a finding.
    CREATE TABLE interest_link_evidence(
      link_key TEXT PRIMARY KEY, evidence_kind TEXT, registry_role TEXT, matched_fact TEXT,
      entry_number TEXT, entry_date TEXT, lookup_date TEXT, rules_version TEXT, live_status TEXT);
    ${bidders.map((b) => `INSERT INTO bidders VALUES (${b});`).join('\n')}
    ${decls.map((d) => `INSERT INTO declarations VALUES (${d});`).join('\n')}
    ${dis.map((d) => `INSERT INTO declared_interests(declaration_id, entity_raw) VALUES (${d});`).join('\n')}
    ${links.map((l) => `INSERT INTO interest_links VALUES (${l});`).join('\n')}
    ${seals.map((e) => `INSERT INTO interest_link_evidence(link_key,evidence_kind,registry_role,matched_fact,lookup_date,rules_version,live_status) VALUES (${e});`).join('\n')}
  `);
  db.close();

  let threw = false;
  let out = '';
  try {
    out = execFileSync(
      'node',
      ['--import', path.join(HERE, 'register-ts.mjs'), path.join(HERE, 'audit.mjs')],
      {
        cwd: ROOT,
        env: { ...process.env, CACBG_DB: DB, CACBG_STAGING: staging },
        encoding: 'utf8',
        stdio: 'pipe',
      },
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
      `'il1','p1|100000001','p1','100000001','${KEY}','declared_eik','confirmed','b1','owns',0,1000,'published'`,
    ],
    seals: [`'p1|100000001','confirmed',NULL,'eik','2026-08-05','tr-rules-1','live'`],
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
      `'il1','p1|300000003','p1','300000003','${KEY}','declared_eik','confirmed','b3','owns',0,1000,'published'`,
    ],
    seals: [`'p1|300000003','confirmed',NULL,'eik','2026-08-05','tr-rules-1','live'`],
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
      `'il1','p1|100000001','p1','100000001','${K('„ОБЩ" ЕООД')}','declared_eik','confirmed','b1','owns',0,1000,'published'`,
    ],
    seals: [`'p1|100000001','confirmed',NULL,'eik','2026-08-05','tr-rules-1','live'`],
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
      `'il1','p1|100000001','p1','100000001','${KEY}','exact_name_key','document','b1','owns',0,1000,'published'`,
    ],
    seals: [
      `'p1|100000001','document','owner','role:owner:CR_F_19_L','2026-08-05','tr-rules-1','live'`,
    ],
  });
  assert.equal(threw, true, 'a name-based colliding published link must still fail');
  assert.equal(/A_multi_eik/.test(out), true, 'invariant A still fires for non-A_eik links');
});

// ── C: evidence honesty (#279, ADR-0033) ─────────────────────────────────────────────────────────
// The axis that used to re-derive name distinctiveness now re-derives the PUBLISHING rule, because the
// publishing rule changed: identity rests on a registry fact, and nameDistinctiveness survives only as
// a withholding filter inside the loader. Re-checking distinctiveness here would assert a rule that is
// no longer in force — a test that passes while guarding nothing.
test('a published link with NO evidence seal is a hard finding', () => {
  const { threw, out } = buildAndAudit({
    bidders: [`'b1','УНИК ТЕХ 7 ЕООД','100000001',1`],
    links: [
      `'il1','p1|100000001','p1','100000001','${K('УНИК ТЕХ 7 ЕООД')}','exact_name_key','document','b1','owns',0,1000,'published'`,
    ],
    seals: [], // the whole point: nothing sealed it
  });
  assert.equal(threw, true, 'publishing without evidence must fail the gate');
  assert.equal(/C_no_evidence/.test(out), true, out);
});

test('a link published on a WITHHOLDING rung is a hard finding', () => {
  // bar_joint_stock / unknown / outside_tr never publish. If one ever reaches status='published', the
  // loader and the seal disagree and a claim is on the surface that no evidence supports.
  const { threw, out } = buildAndAudit({
    bidders: [`'b1','УНИК ТЕХ 7 ЕООД','100000001',1`],
    links: [
      `'il1','p1|100000001','p1','100000001','${K('УНИК ТЕХ 7 ЕООД')}','exact_name_key','unknown','b1','owns',0,1000,'published'`,
    ],
    seals: [`'p1|100000001','unknown',NULL,NULL,'2026-08-05','tr-rules-1','live'`],
  });
  assert.equal(threw, true);
  assert.equal(/C_withholding_evidence/.test(out), true, out);
});

test('a tier that disagrees with its own seal is a hard finding', () => {
  const { threw, out } = buildAndAudit({
    bidders: [`'b1','УНИК ТЕХ 7 ЕООД','100000001',1`],
    links: [
      `'il1','p1|100000001','p1','100000001','${K('УНИК ТЕХ 7 ЕООД')}','exact_name_key','document','b1','owns',0,1000,'published'`,
    ],
    seals: [`'p1|100000001','confirmed',NULL,'eik','2026-08-05','tr-rules-1','live'`],
  });
  assert.equal(threw, true);
  assert.equal(/C_tier_evidence_mismatch/.test(out), true, out);
});

test('a matched_fact outside the closed vocabulary is a hard finding — the name-leak rail', () => {
  // #279 §9: the deed's names are read only to produce a boolean and must never reach a served column.
  // A schema cannot enforce a vocabulary, so the audit does. This is the shape a leak would take.
  const { threw, out } = buildAndAudit({
    bidders: [`'b1','УНИК ТЕХ 7 ЕООД','100000001',1`],
    links: [
      `'il1','p1|100000001','p1','100000001','${K('УНИК ТЕХ 7 ЕООД')}','exact_name_key','document','b1','owns',0,1000,'published'`,
    ],
    seals: [
      `'p1|100000001','document','owner','ИВАН ПЕТРОВ ТЕСТОВ','2026-08-05','tr-rules-1','live'`,
    ],
  });
  assert.equal(threw, true, 'a name in matched_fact must fail the gate');
  assert.equal(/C_matched_fact_shape/.test(out), true, out);
});

// …and the rail must catch the shape a leak would ACTUALLY take. `seat:<CITY>` is a legitimate member
// of the vocabulary, so an unbounded `seat:[\p{Lu} -]+` admits `seat:ИВАН ПЕТРОВ ГЕОРГИЕВ` — a full
// three-part Bulgarian name (ЗГР чл. 9) wearing the prefix of a fact we allow. That is precisely the
// value the rail exists to reject, and it is the one a mis-split of the seat field would produce.
// A Bulgarian settlement is one or two tokens („СОФИЯ", „ВЕЛИКО ТЪРНОВО", „ГЕНЕРАЛ ТОШЕВО"); the
// three-part name is exactly three. The bound is deliberately tight: a rarer 3-token seat trips the
// audit and a human adjudicates, which is the correct direction for a rail whose failure mode is
// publishing somebody's name.
test('a THREE-TOKEN seat is a name shape, not a settlement — the rail must catch it', () => {
  const { threw, out } = buildAndAudit({
    bidders: [`'b1','УНИК ТЕХ 7 ЕООД','100000001',1`],
    links: [
      `'il1','p1|100000001','p1','100000001','${K('УНИК ТЕХ 7 ЕООД')}','exact_name_key','confirmed','b1','owns',0,1000,'published'`,
    ],
    seals: [
      `'p1|100000001','confirmed',NULL,'seat:ИВАН ПЕТРОВ ГЕОРГИЕВ','2026-08-05','tr-rules-1','live'`,
    ],
  });
  assert.equal(threw, true, 'a three-part name behind seat: must fail the gate');
  assert.equal(/C_matched_fact_shape/.test(out), true, out);
});

test('a real two-token settlement still passes — the bound must not empty the seat rung', () => {
  const { threw } = buildAndAudit({
    bidders: [`'b1','УНИК ТЕХ 7 ЕООД','100000001',1`],
    links: [
      `'il1','p1|100000001','p1','100000001','${K('УНИК ТЕХ 7 ЕООД')}','exact_name_key','confirmed','b1','owns',0,1000,'published'`,
    ],
    seals: [
      `'p1|100000001','confirmed',NULL,'seat:ВЕЛИКО ТЪРНОВО','2026-08-05','tr-rules-1','live'`,
    ],
  });
  assert.equal(threw, false, 'ВЕЛИКО ТЪРНОВО is a settlement and must survive the rail');
});

test('a well-formed seal passes every C axis (positive control)', () => {
  // Without this, all four negatives above would still pass if the axes fired unconditionally.
  const { threw } = buildAndAudit({
    bidders: [`'b1','УНИК ТЕХ 7 ЕООД','100000001',1`],
    links: [
      `'il1','p1|100000001','p1','100000001','${K('УНИК ТЕХ 7 ЕООД')}','exact_name_key','document','b1','owns',0,1000,'published'`,
    ],
    seals: [
      `'p1|100000001','document','owner','role:owner:CR_F_19_L','2026-08-05','tr-rules-1','live'`,
    ],
  });
  assert.equal(threw, false, 'a correctly sealed link must not fail the gate');
});

// ── D. Monotonicity (ADR-0033 decision 6) ────────────────────────────────────────────────────────
// #279 §8 asked for a seal kept „forever" and strictly-additive recomputation. ADR-0033 showed that is
// false (labels flip, the cache expires, a court can annul an entry) and replaced the STORE with a
// GATE: seals are re-derived every run, and the audit compares the current published set against the
// pre-wipe export. A link that vanishes under an UNCHANGED rules_version is a hard finding — nothing
// about the rules changed, so its disappearance is a regression, not a decision.
//
// Why this needs its own gate and ship's count floor cannot serve: assertShipFloor checks a COUNT.
// A one-for-one swap — one link lost, one gained — leaves the count identical and the floor silent
// while a true published link is dropped. Only a per-key comparison sees it.
const SEALED = [
  `'p1|100000001','document','owner','role:owner:CR_F_19_L','2026-08-05','tr-rules-1','live'`,
];
const ONE_LINK = {
  bidders: [`'b1','УНИК ТЕХ 7 ЕООД','100000001',1`, `'b2','ВТОРА ФИРМА ЕООД','200000002',1`],
  links: [
    `'il1','p1|100000001','p1','100000001','${K('УНИК ТЕХ 7 ЕООД')}','exact_name_key','document','b1','owns',0,1000,'published'`,
  ],
  seals: SEALED,
};

test('D — a previously published link that vanished under an UNCHANGED rules_version is a hard finding', () => {
  const { threw, out } = buildAndAudit({
    ...ONE_LINK,
    snapshot: [
      { link_key: 'p1|100000001', rules_version: 'tr-rules-1' },
      { link_key: 'p9|200000002', rules_version: 'tr-rules-1' }, // published last run, gone now
    ],
  });
  assert.equal(threw, true, 'a silent recall regression must fail the build');
  assert.match(out, /D_monotonicity/);
  assert.match(out, /p9\|200000002/);
});

test('D — the same disappearance under a CHANGED rules_version is a printed diff, not a finding', () => {
  // Removal stays an intentional event: bumping the rules version is how you declare one.
  const { threw, out } = buildAndAudit({
    ...ONE_LINK,
    snapshot: [{ link_key: 'p9|200000002', rules_version: 'tr-rules-0' }],
  });
  assert.equal(threw, false, 'a declared rules change must not fail the build');
  assert.match(out, /p9\|200000002/, 'but it must still be reported');
});

test('D — no snapshot (a first run) neither fires nor crashes', () => {
  const { threw } = buildAndAudit(ONE_LINK);
  assert.equal(threw, false);
});

// The gate must also let the two removals ADR-0033 decision 6 actually SANCTIONS through, or it
// deadlocks the mechanisms it points at. Both are declared events with a reviewed paper trail in git;
// neither is a silent recall regression, and the gate exists to tell those apart.

test('D — a link taken down through the ADR-0031 suppression path is a declared removal, not a regression', () => {
  // Decision 6 names the court-annulled entry (чл. 29 ЗТРРЮЛНЦ) and wires it to ADR-0031. That path
  // flips status published → suppressed, so the link leaves the published set with rules_version
  // unchanged — firing the gate on the ONE removal the ADR explicitly licenses.
  const { threw, out } = buildAndAudit({
    ...ONE_LINK,
    links: [
      ...ONE_LINK.links,
      `'il2','p9|200000002','p9','200000002','${K('ВТОРА ФИРМА ЕООД')}','exact_name_key','document','b2','owns',0,1000,'suppressed'`,
    ],
    snapshot: [
      { link_key: 'p1|100000001', rules_version: 'tr-rules-1' },
      { link_key: 'p9|200000002', rules_version: 'tr-rules-1' },
    ],
  });
  assert.equal(threw, false, 'the sanctioned takedown path must not fail the build');
  assert.match(out, /p9\|200000002/, 'but a withdrawn public claim is never silent');
});

test('D — a snapshot entry acknowledged as a corrected input is a declared removal', () => {
  // The other sanctioned ground: the link should never have been published because its INPUT was
  // wrong. Suppression cannot express it — correcting the input unbuilds the link, and load.mjs's B3
  // gate then fails the build for a suppression that matched nothing. Without this the two sanctioned
  // removals fail in opposite directions and there is no way to clear either.
  const { threw, out } = buildAndAudit({
    ...ONE_LINK,
    snapshot: [
      { link_key: 'p1|100000001', rules_version: 'tr-rules-1' },
      { link_key: 'p9|200000002', rules_version: 'tr-rules-1', corrected: true },
    ],
  });
  assert.equal(threw, false, 'an acknowledged correction must not fail the build');
  assert.match(out, /p9\|200000002/);
});

test('D — neither escape hatch fires on its own: an unacknowledged, unsuppressed drop still hard-fails', () => {
  // The mutation control for the two tests above. A gate that accepted every disappearance would pass
  // both of them, and this is the assertion that says it did not.
  const { threw } = buildAndAudit({
    ...ONE_LINK,
    links: [
      ...ONE_LINK.links,
      `'il2','p9|200000002','p9','200000002','${K('ВТОРА ФИРМА ЕООД')}','exact_name_key','document','b2','owns',0,1000,'held'`,
    ],
    snapshot: [
      { link_key: 'p1|100000001', rules_version: 'tr-rules-1' },
      { link_key: 'p9|200000002', rules_version: 'tr-rules-1' },
    ],
  });
  assert.equal(
    threw,
    true,
    'held is not a sanctioned removal — the evidence simply stopped licensing it',
  );
});

test('D positive control — an unchanged published set produces no monotonicity finding', () => {
  // Without this, a gate that never fires would pass both negatives above.
  const { threw, out } = buildAndAudit({
    ...ONE_LINK,
    snapshot: [{ link_key: 'p1|100000001', rules_version: 'tr-rules-1' }],
  });
  assert.equal(threw, false);
  assert.doesNotMatch(out, /D_monotonicity/);
});

// The four axes below fire on shapes that no test exercised. Each is a hard finding — the audit is the
// last gate before a named claim ships — so an axis that silently stopped firing would be invisible.

test('A_key_missing: a link whose entity_key is in NO live bidder → hard finding', () => {
  // The key resolved when the link was built and does not now: the winner was renamed, re-keyed or
  // dropped from the corpus. The link still names an official against a company we can no longer find,
  // so it must stop the run rather than ship pointing at nothing.
  const { threw, out } = buildAndAudit({
    bidders: [`'b1','РЕАЛЕН ЕООД','100000001',1`],
    links: [
      `'il1','p1|100000001','p1','100000001','${K('ИЗЧЕЗНАЛ ЕООД')}','exact_name_key','document','b1','owns',0,1000,'published'`,
    ],
    seals: [
      `'p1|100000001','document','owner','role:owner:CR_F_19_L','2026-08-12','tr-rules-1','live'`,
    ],
  });
  assert.equal(threw, true, 'an unresolvable entity_key must fail the gate');
  assert.equal(/A_key_missing/.test(out), true);
});

test('A_eik_mismatch: a name-resolved key pointing at a DIFFERENT ЕИК than it resolves to → hard', () => {
  // The libel case in its purest form: the name resolves to exactly one winner, and the link published a
  // different company against it. Everything on the card — contracts, money, the ЕИК link — would be the
  // wrong company's, under a real official's name.
  const { threw, out } = buildAndAudit({
    bidders: [`'b1','РЕАЛЕН ЕООД','100000001',1`, `'b2','ДРУГ ЕООД','200000002',1`],
    links: [
      `'il1','p1|200000002','p1','200000002','${K('РЕАЛЕН ЕООД')}','exact_name_key','document','b2','owns',0,1000,'published'`,
    ],
    seals: [
      `'p1|200000002','document','owner','role:owner:CR_F_19_L','2026-08-12','tr-rules-1','live'`,
    ],
  });
  assert.equal(threw, true);
  assert.equal(/A_eik_mismatch/.test(out), true);
});

test('B_bidder_eik: the stored bidder row disagrees with the link ЕИК → hard finding', () => {
  // Row integrity. The card renders the BIDDER's name and money but links out on the link's ЕИК, so a
  // disagreement means the reader is shown one company and sent to another.
  const { threw, out } = buildAndAudit({
    bidders: [`'b1','РЕАЛЕН ЕООД','100000001',1`, `'b2','ДРУГ ЕООД','200000002',1`],
    links: [
      `'il1','p1|100000001','p1','100000001','${K('РЕАЛЕН ЕООД')}','exact_name_key','document','b2','owns',0,1000,'published'`,
    ],
    seals: [
      `'p1|100000001','document','owner','role:owner:CR_F_19_L','2026-08-12','tr-rules-1','live'`,
    ],
  });
  assert.equal(threw, true);
  assert.equal(/B_bidder_eik/.test(out), true);
});

test('B_eik_invalid: publishing against a checksum-INVALID ЕИК → hard finding', () => {
  // eik_valid=0 means the ЕИК failed its control digit, so it identifies no company at all. This axis is
  // the rail that keeps such a row off the public surface, and nothing else re-checks it downstream.
  const { threw, out } = buildAndAudit({
    bidders: [`'b1','РЕАЛЕН ЕООД','100000001',0`],
    links: [
      `'il1','p1|100000001','p1','100000001','${K('РЕАЛЕН ЕООД')}','exact_name_key','document','b1','owns',0,1000,'published'`,
    ],
    seals: [
      `'p1|100000001','document','owner','role:owner:CR_F_19_L','2026-08-12','tr-rules-1','live'`,
    ],
  });
  assert.equal(threw, true, 'an invalid-ЕИК publish must fail the gate');
  assert.equal(/B_eik_invalid/.test(out), true);
});

test('the four axes above are a BOUND: a clean, valid, sealed link passes them all', () => {
  // POSITIVE CONTROL for the whole block. Four assertions that something fails prove nothing unless the
  // correct shape passes — an audit that flagged everything would satisfy every test above.
  const { threw, out } = buildAndAudit({
    bidders: [`'b1','РЕАЛЕН ЕООД','100000001',1`],
    links: [
      `'il1','p1|100000001','p1','100000001','${K('РЕАЛЕН ЕООД')}','exact_name_key','document','b1','owns',0,1000,'published'`,
    ],
    seals: [
      `'p1|100000001','document','owner','role:owner:CR_F_19_L','2026-08-12','tr-rules-1','live'`,
    ],
  });
  assert.equal(threw, false, `a clean link must pass: ${out}`);
  for (const axis of ['A_key_missing', 'A_eik_mismatch', 'B_bidder_eik', 'B_eik_invalid'])
    assert.equal(new RegExp(axis).test(out), false, `${axis} must not fire on a clean link`);
});
