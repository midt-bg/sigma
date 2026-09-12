// node:test — the evidence ladder (ADR-0033 decision 1). Pure: registry facts in, verdict out.
//
// Six outcomes, first match wins. What each rung is allowed to CONCLUDE is the whole subject:
// the registry proves the identity of the COMPANY, never that the official owns it — the ownership
// claim comes from the official's own filed declaration. So a wrong match here does not invent an
// ownership claim, it attaches a real official to the wrong company's ЕИК, contracts and money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RULES_VERSION,
  evidenceVerdict,
  reconcileTermination,
  MATCHED_FACT_RE,
  isSealedFact,
} from './evidence.mjs';
import { registryFacts, OWNERSHIP_FIELDS } from './deed.mjs';

// One registered person in one role, as the registry layer keeps it: every holder its own row.
const holder = (field, name, entryDate = '2011-05-02', over = {}) => ({
  field_ident: field,
  subject_kind: 'person',
  subject_name: name,
  entry_number: '20110502101007',
  added_on: entryDate,
  removed_on: null,
  ...over,
});
// The ownership record is dated by the latest entry of the ownership fields that stand — the way the
// registry layer dates it — unless a test says otherwise.
const ownersDate = (holders) =>
  holders
    .filter((h) => OWNERSHIP_FIELDS.includes(h.field_ident) && h.removed_on == null)
    .map((h) => h.added_on)
    .sort()
    .at(-1) ?? null;
const registry = (holders, over = {}) =>
  registryFacts(
    {
      eik: '201122335',
      name: '"АЛФА СТРОЙ" ООД',
      legal_form: 'OOD',
      seat_settlement: null,
      seat_entry_on: null,
      owners_entry_on: ownersDate(holders),
      ...over,
    },
    holders,
  );
const seatIn = (settlement, entryOn = '2011-05-02') => ({
  seat_settlement: settlement,
  seat_entry_on: entryOn,
});

const OWNER = registry(
  [holder('00190', 'ИВАН ПЕТРОВ ТЕСТОВ'), holder('00190', 'МАРИЯ СТОЯНОВА ИВАНОВА')],
  seatIn('гр. Пловдив'),
);

const base = {
  registry: OWNER,
  declarantName: 'Иван Петров Тестов',
  declaredSeats: [],
  declaredEik: false,
  firstDeclaredYear: 2021,
  scope: 'self',
  nameGloballyUnique: true,
  // The company was resolved by a name unlikely to have a national twin. The rung-2 tests below are about
  // NAME matching, so they hold this dimension fixed; the gate itself is tested separately.
  companyNameDistinctive: true,
};

test('RULES_VERSION is a stable, non-empty identifier — §8 hangs off it', () => {
  assert.equal(typeof RULES_VERSION, 'string');
  assert.ok(RULES_VERSION.length > 0);
});

// ── rung 1: the joint-stock bar wins over everything ──────────────────────────
test('rung 1 — a joint-stock company is barred even when the person IS registered in it', () => {
  const ad = registry([holder('00190', 'ИВАН ПЕТРОВ ТЕСТОВ')], {
    legal_form: 'AD',
    name: '"ГАМА ИНВЕСТ" АД',
  });
  const v = evidenceVerdict({ ...base, registry: ad });
  assert.equal(v.kind, 'bar_joint_stock');
  assert.equal(v.publishable, false);
});

test('rung 1 — the suffix alone bars a company whose code reads closely held (the bar is a union)', () => {
  const ad = registry([holder('00190', 'ИВАН ПЕТРОВ ТЕСТОВ')], { name: '"ГАМА" АД' });
  assert.equal(evidenceVerdict({ ...base, registry: ad }).kind, 'bar_joint_stock');
});

test('rung 1 — an UNKNOWN legal form withholds; it never falls through to a lower rung', () => {
  const odd = registry([holder('00190', 'ИВАН ПЕТРОВ ТЕСТОВ')], {
    legal_form: 'XYZ',
    name: 'НЕЩО БЕЗ ФОРМА',
  });
  const v = evidenceVerdict({ ...base, registry: odd });
  assert.equal(v.kind, 'unknown');
  assert.equal(v.publishable, false);
});

// ── rung 2: „Документ" ────────────────────────────────────────────────────────
test('rung 2 — a full-name match in a standing ownership role publishes, with the role kept', () => {
  const v = evidenceVerdict(base);
  assert.equal(v.kind, 'document');
  assert.equal(v.publishable, true);
  assert.equal(v.registryRole, 'owner');
  assert.equal(v.matchedFact, 'role:owner:00190');
  assert.equal(v.entryNumber, '20110502101007');
  assert.equal(v.entryDate, '2011-05-02');
});

test('rung 2 — a manager-only match publishes but records the weaker role', () => {
  const mgr = registry([holder('00070', 'ИВАН ПЕТРОВ ТЕСТОВ'), holder('00190', 'ДРУГО ЛИЦЕ ТУК')]);
  const v = evidenceVerdict({ ...base, registry: mgr });
  assert.equal(v.kind, 'document');
  assert.equal(v.registryRole, 'manager');
  assert.equal(v.matchedFact, 'role:manager:00070');
});

test('rung 2 — a TWO-token declarant can never earn „Документ"', () => {
  // 46 of 301 measured matches were two-token only, which is exactly the homonym risk. Falls to a
  // lower rung rather than publishing on a name that half a register could satisfy.
  const two = registry([holder('00190', 'ИВАН ТЕСТОВ')]);
  const v = evidenceVerdict({ ...base, registry: two, declarantName: 'Иван Тестов' });
  assert.notEqual(v.kind, 'document');
  assert.equal(v.shortName, true, 'the refusal is counted, not silently dropped');
});

test('rung 2 — the match must fall inside ONE registered person (the libel guard, end to end)', () => {
  const two = registry([
    holder('00190', 'ПЕНКО НЕСТОРОВ НЕСТОРОВ'),
    holder('00190', 'ИЛИЯН КОСТАДИНОВ ФИЛИПОВ'),
  ]);
  const v = evidenceVerdict({ ...base, registry: two, declarantName: 'ПЕНКО КОСТАДИНОВ ФИЛИПОВ' });
  assert.notEqual(v.kind, 'document');
});

test('rung 2 — an ended role outside the declared year cannot produce a document match', () => {
  const gone = registry([
    holder('00230', 'ИВАН ПЕТРОВ ТЕСТОВ', '2013-07-16', { removed_on: '2015-01-01' }),
  ]);
  assert.notEqual(evidenceVerdict({ ...base, registry: gone }).kind, 'document');
});

test('a documented past owner corroborates historical identity without becoming a current owner', () => {
  const past = registry([
    holder('00190', 'ИВАН ПЕТРОВ ТЕСТОВ', '2013-07-16', { removed_on: '2022-01-01' }),
  ]);
  const v = evidenceVerdict({ ...base, registry: past });
  assert.equal(v.kind, 'document');
  assert.equal(v.registryRole, 'owner');
  assert.equal(v.roleEndedOn, '2022-01-01');
  assert.equal(v.entryDate, '2013-07-16');
  assert.deepEqual(reconcileTermination({ registry: past, declarantName: base.declarantName }), {
    terminated: true,
    label: null,
  });
});

test('historical matches still require company corroboration and one exact full person name', () => {
  const past = registry([
    holder('00190', 'ИВАН ПЕТРОВ ТЕСТОВ', '2013-07-16', { removed_on: '2022-01-01' }),
  ]);
  assert.equal(
    evidenceVerdict({ ...base, registry: past, companyNameDistinctive: false }).kind,
    'document_uncorroborated',
  );
  assert.notEqual(
    evidenceVerdict({ ...base, registry: past, declarantName: 'Иван Тестов' }).kind,
    'document',
  );
  assert.notEqual(
    evidenceVerdict({ ...base, registry: past, declarantName: 'Иван Петров Другов' }).kind,
    'document',
  );
  assert.equal(
    evidenceVerdict({ ...base, registry: past, companyNameDistinctive: false, declaredEik: true })
      .kind,
    'document',
  );
});

test('historical identity requires valid dates, a real entry and overlap with the first declared year', () => {
  for (const over of [
    { added_on: null },
    { added_on: '2021-02-30' },
    { removed_on: '2021-02-30' },
    { added_on: '2022-01-01' },
    { removed_on: '2021-01-01' },
    { added_on: '2022-02-01', removed_on: '2022-01-01' },
    { entry_number: null },
    { subject_kind: 'entity' },
  ]) {
    const past = registry([
      holder('00190', base.declarantName, '2020-01-01', { removed_on: '2022-01-01', ...over }),
    ]);
    assert.notEqual(
      evidenceVerdict({ ...base, registry: past }).kind,
      'document',
      JSON.stringify(over),
    );
  }
  const past = registry([
    holder('00070', base.declarantName, '2021-12-31', { removed_on: '2022-01-01' }),
  ]);
  assert.equal(evidenceVerdict({ ...base, registry: past }).registryRole, 'manager');
  assert.notEqual(
    evidenceVerdict({ ...base, registry: past, firstDeclaredYear: null }).kind,
    'document',
  );
});

test('rung 2 — a company the register names is no declarant, whatever its name', () => {
  const firm = registry([
    holder('00190', 'ИВАН ПЕТРОВ ТЕСТОВ', '2011-05-02', { subject_kind: 'entity' }),
  ]);
  assert.notEqual(evidenceVerdict({ ...base, registry: firm }).kind, 'document');
});

test('rung 2 — an actual owner is not a role the ladder reads', () => {
  const ubo = registry([holder('05500', 'ИВАН ПЕТРОВ ТЕСТОВ')]);
  assert.notEqual(evidenceVerdict({ ...base, registry: ubo }).kind, 'document');
});

test('rung 2 — a Latin homoglyph in the name is a NON-match, and is counted', () => {
  // company-name-key.ts deliberately does not fold Cyrillic↔Latin; person names take the same posture.
  const v = evidenceVerdict({ ...base, declarantName: 'ИBAH ПЕТРОВ ТЕСТОВ' }); // Latin B, A, H
  assert.notEqual(v.kind, 'document');
  assert.equal(v.latinInName, true);
});

// ── rung 3: „Потвърдено" ──────────────────────────────────────────────────────
const somebodyElse = (over = {}) => registry([holder('00190', 'НЯКОЙ ДРУГ ЧОВЕК')], over);

test('rung 3 — a declared seat matching the registered seat confirms the company', () => {
  const other = somebodyElse(seatIn('гр. Пловдив', '2015-01-01'));
  const v = evidenceVerdict({ ...base, registry: other, declaredSeats: ['Пловдив'] });
  assert.equal(v.kind, 'confirmed');
  assert.equal(v.publishable, true);
  assert.equal(v.matchedFact, 'seat:ПЛОВДИВ');
});

test('rung 3 — a declared ЕИК confirms the company on its own', () => {
  const v = evidenceVerdict({ ...base, registry: somebodyElse(), declaredEik: true });
  assert.equal(v.kind, 'confirmed');
  assert.equal(v.matchedFact, 'eik');
});

test('rung 3 — an EMPTY declared seat never confirms', () => {
  const v = evidenceVerdict({ ...base, registry: somebodyElse(), declaredSeats: ['', '   '] });
  assert.notEqual(v.kind, 'confirmed');
});

test('rung 3 — a seat registered AFTER the declared period does not confirm', () => {
  // R10, and W0 measured that seats move: a company that relocated INTO the declared settlement after
  // the fact would otherwise produce a false „Потвърдено".
  const moved = somebodyElse(seatIn('гр. Пловдив', '2024-06-01'));
  const v = evidenceVerdict({
    ...base,
    registry: moved,
    declaredSeats: ['Пловдив'],
    firstDeclaredYear: 2021,
  });
  assert.notEqual(v.kind, 'confirmed');
});

test('rung 3 — an UNKNOWN first declared year cannot confirm on a seat', () => {
  // R10 again, from the other side. A null year means the temporal check has NOTHING to compare
  // against — not that the seat covers the period. An unknown guard is a failed guard.
  const moved = somebodyElse(seatIn('гр. Пловдив', '2024-06-01'));
  const v = evidenceVerdict({
    ...base,
    registry: moved,
    declaredSeats: ['Пловдив'],
    firstDeclaredYear: null,
  });
  assert.notEqual(v.kind, 'confirmed');
});

test('rung 3 — an unknown year holds a seat match even when the seat has NO entry date', () => {
  // Two unknowns and zero evidence about the period: rung 4 already refuses to run without a year, and
  // the seat leg must refuse on the same ground, or the weakest rung is the one with no temporal check.
  const undated = somebodyElse(seatIn('гр. Пловдив', null));
  const v = evidenceVerdict({
    ...base,
    registry: undated,
    declaredSeats: ['Пловдив'],
    firstDeclaredYear: null,
  });
  assert.notEqual(v.kind, 'confirmed', 'two unknowns must not multiply into a public claim');
});

test('rung 3 — a KNOWN year with an undated seat still confirms (the guard is not a blanket)', () => {
  const undated = somebodyElse(seatIn('гр. Пловдив', null));
  const v = evidenceVerdict({
    ...base,
    registry: undated,
    declaredSeats: ['Пловдив'],
    firstDeclaredYear: 2021,
  });
  assert.equal(v.kind, 'confirmed');
  assert.equal(v.matchedFact, 'seat:ПЛОВДИВ');
});

test('rung 3 — the weakest rung ALSO requires global name uniqueness (ADR-0017 carried forward)', () => {
  const v = evidenceVerdict({
    ...base,
    registry: somebodyElse(seatIn('гр. Пловдив')),
    declaredSeats: ['Пловдив'],
    nameGloballyUnique: false,
  });
  assert.notEqual(v.kind, 'confirmed', 'a nationally shared name cannot ride the weakest rung');
});

test('rung 3 — a declared ЕИК is NOT gated by name uniqueness (ADR-0028)', () => {
  const v = evidenceVerdict({
    ...base,
    registry: somebodyElse(),
    declaredEik: true,
    nameGloballyUnique: false,
  });
  assert.equal(v.kind, 'confirmed');
  assert.equal(v.matchedFact, 'eik');
});

test('rung 3 — the seat rung DOES rescue a merely generic name; it is uniqueness that gates it', () => {
  const v = evidenceVerdict({
    ...base,
    registry: somebodyElse(seatIn('гр. Пловдив')),
    declaredSeats: ['Пловдив'],
    nameGloballyUnique: true,
  });
  assert.equal(v.kind, 'confirmed');
  assert.equal(v.matchedFact, 'seat:ПЛОВДИВ');
});

test('rung 3 — name uniqueness does NOT gate the stronger „Документ" rung', () => {
  const v = evidenceVerdict({ ...base, nameGloballyUnique: false });
  assert.equal(
    v.kind,
    'document',
    'the registry named the person in THIS company; the name key is moot',
  );
});

test('rung 2 — every OWNERSHIP field can carry the match: partners, sole owner, the trader', () => {
  // A sole owner (the commonest ЕООД form) publishing as „Неизвестна" would be a recall hole with no
  // symptom, so every ownership field is exercised, not just the partners'.
  assert.deepEqual(OWNERSHIP_FIELDS, [
    '00180',
    '00190',
    '00200',
    '00201',
    '00210',
    '00230',
    '00231',
  ]);
  for (const code of OWNERSHIP_FIELDS) {
    const v = evidenceVerdict({
      ...base,
      registry: registry([holder(code, 'ИВАН ПЕТРОВ ТЕСТОВ')]),
    });
    assert.equal(v.kind, 'document', `${code} must carry an ownership match`);
    assert.equal(v.registryRole, 'owner', `${code} is an OWNERSHIP field, not management`);
    assert.equal(v.matchedFact, `role:owner:${code}`);
  }
  // POSITIVE CONTROL — a field that is NOT an ownership or manager field must not match at all, or the
  // loop above would pass for a reason other than the one it claims.
  const other = registry([holder('00100', 'ИВАН ПЕТРОВ ТЕСТОВ')]);
  assert.notEqual(evidenceVerdict({ ...base, registry: other }).kind, 'document');
});

// ── rung 2's company gate: the winner-vs-non-winner homonym (ADR-0035) ────────
test('rung 2 — a GENERIC company name with no corroboration cannot publish on a name match alone', () => {
  const v = evidenceVerdict({ ...base, companyNameDistinctive: false });
  assert.equal(v.kind, 'document_uncorroborated');
  assert.equal(v.publishable, false);
  // It must not fall through to `unknown`, and it must carry neither a role nor a fact.
  assert.equal(v.registryRole, null);
  assert.equal(v.matchedFact, null);
});

test('rung 2 — a declared ЕИК corroborates the company, so the name match publishes', () => {
  const v = evidenceVerdict({ ...base, companyNameDistinctive: false, declaredEik: true });
  assert.equal(v.kind, 'document');
  assert.equal(v.publishable, true);
  assert.equal(v.registryRole, 'owner');
});

test('rung 2 — a declared seat matching the registered seat corroborates the company', () => {
  const v = evidenceVerdict({
    ...base,
    companyNameDistinctive: false,
    declaredSeats: ['гр. Пловдив'],
  });
  assert.equal(v.kind, 'document');
  assert.equal(v.publishable, true);
});

test('rung 2 — a DISTINCTIVE company name publishes uncorroborated (the gate is not a blanket)', () => {
  const v = evidenceVerdict({ ...base, companyNameDistinctive: true });
  assert.equal(v.kind, 'document');
  assert.equal(v.publishable, true);
});

test('rung 2 — a seat that does NOT match cannot corroborate a generic name', () => {
  const v = evidenceVerdict({
    ...base,
    companyNameDistinctive: false,
    declaredSeats: ['гр. Бургас'], // the register says Пловдив
  });
  assert.equal(v.kind, 'document_uncorroborated');
  assert.equal(v.publishable, false);
});

test('rung 2 — the seat corroborator carries the SAME temporal guard as rung 3 (R10)', () => {
  const moved = registry(
    [holder('00190', 'ИВАН ПЕТРОВ ТЕСТОВ')],
    seatIn('гр. Пловдив', '2023-07-01'),
  );
  const v = evidenceVerdict({
    ...base,
    registry: moved,
    companyNameDistinctive: false,
    declaredSeats: ['гр. Пловдив'],
    firstDeclaredYear: 2021,
  });
  assert.equal(v.kind, 'document_uncorroborated');
});

test('rung 2 — the company gate never rescues a link rung 1 has barred', () => {
  const ad = registry([holder('00190', 'ИВАН ПЕТРОВ ТЕСТОВ')], {
    legal_form: 'AD',
    name: '"ГАМА ИНВЕСТ" АД',
  });
  const v = evidenceVerdict({
    ...base,
    registry: ad,
    companyNameDistinctive: true,
    declaredEik: true,
  });
  assert.equal(v.kind, 'bar_joint_stock');
});

// ── rung 4: „Оборена" ─────────────────────────────────────────────────────────
test('rung 4 — registered nowhere, in a company whose ownership predates the declaration, refutes', () => {
  const older = registry([holder('00190', 'СЪВСЕМ ДРУГ СОБСТВЕНИК', '2015-03-01')]);
  const v = evidenceVerdict({ ...base, registry: older, firstDeclaredYear: 2021 });
  assert.equal(v.kind, 'refuted');
  assert.equal(v.publishable, false);
});

test('rung 4 — a role that ENDED before the period is not a role now', () => {
  const sold = registry([
    holder('00190', 'ИВАН ПЕТРОВ ТЕСТОВ', '2009-01-01', { removed_on: '2014-01-01' }),
    holder('00190', 'СЪВСЕМ ДРУГ СОБСТВЕНИК', '2014-01-01'),
  ]);
  assert.equal(
    evidenceVerdict({ ...base, registry: sold, firstDeclaredYear: 2021 }).kind,
    'refuted',
  );
});

test('rung 4 — the comparison is date-to-DATE, not date-to-year', () => {
  // R17: „strictly before the first declared year" means before YYYY-01-01. An entry inside the first
  // declared year does NOT cover the period and must not refute.
  const inYear = registry([holder('00190', 'ДРУГ СОБСТВЕНИК', '2021-06-15')]);
  assert.notEqual(
    evidenceVerdict({ ...base, registry: inYear, firstDeclaredYear: 2021 }).kind,
    'refuted',
  );
  const justBefore = registry([holder('00190', 'ДРУГ СОБСТВЕНИК', '2020-12-31')]);
  assert.equal(
    evidenceVerdict({ ...base, registry: justBefore, firstDeclaredYear: 2021 }).kind,
    'refuted',
  );
});

test('rung 4 — NEVER applies to a family stake', () => {
  // The owner there is the relative, whose name we neither store nor check (ADR-0010 item 4,
  // ADR-0032 decision 2), so „the official is not registered" says nothing at all.
  const older = registry([holder('00190', 'ДРУГ СОБСТВЕНИК', '2015-03-01')]);
  const v = evidenceVerdict({ ...base, registry: older, scope: 'family', firstDeclaredYear: 2021 });
  assert.notEqual(v.kind, 'refuted');
  assert.equal(v.kind, 'unknown');
});

test('rung 4 — suppressed inside the 2011–2012 re-registration window', () => {
  // R13: court-registered companies had every entry date flattened into the re-registration window,
  // so „strictly before" certifies nothing there.
  const flattened = registry([holder('00190', 'ДРУГ СОБСТВЕНИК', '2011-11-04')]);
  const v = evidenceVerdict({ ...base, registry: flattened, firstDeclaredYear: 2021 });
  assert.notEqual(v.kind, 'refuted');
  assert.equal(v.kind, 'unknown');
});

// ── rungs 5 and 6 ─────────────────────────────────────────────────────────────
test('rung 5 — everything else is „Неизвестна" and stays hidden', () => {
  const recent = registry([holder('00190', 'ДРУГ СОБСТВЕНИК', '2023-01-01')]);
  const v = evidenceVerdict({ ...base, registry: recent, firstDeclaredYear: 2021 });
  assert.equal(v.kind, 'unknown');
  assert.equal(v.publishable, false);
});

test('rung 6 — outside the register is its own outcome, and is not publishable', () => {
  const v = evidenceVerdict({ ...base, registry: null, outsideTr: true });
  assert.equal(v.kind, 'outside_tr');
  assert.equal(v.publishable, false);
});

test('missing registry facts NOT marked outside-ТР are an error, not a silent hold', () => {
  // Fail closed: a gap must be visible, never quietly downgraded to „unknown".
  assert.throws(() => evidenceVerdict({ ...base, registry: null, outsideTr: false }), /registry/i);
});

// ── the seal ──────────────────────────────────────────────────────────────────
test('MATCHED_FACT_RE bounds a settlement to two tokens and a field to its code — a NAME cannot pass', () => {
  for (const ok of [
    'seat:СОФИЯ',
    'seat:ВЕЛИКО ТЪРНОВО', // a real two-token settlement must still pass
    'seat:ГЕНЕРАЛ ТОШЕВО',
    'seat:ЦАР-КАЛОЯН', // hyphenated is one token
    'role:owner:00190',
    'role:owner:00230',
    'role:manager:00070',
    'role:owner:CR_F_19_L', // sealed before tr-rules-3
    'role:manager:CR_F_7_L',
    'role:owner:CR_F_23_L',
    'eik',
  ])
    assert.equal(MATCHED_FACT_RE.test(ok), true, `wrongly rejected: ${ok}`);

  for (const bad of [
    'seat:ИВАН ПЕТРОВ ГЕОРГИЕВ', // THE case: three tokens is a name, not a settlement
    'seat:ИВАН ПЕТРОВ ГЕОРГИЕВ ДРУГ',
    'ИВАН ПЕТРОВ ГЕОРГИЕВ', // a bare name with no prefix at all
    'role:owner:ИВАН ПЕТРОВ', // a name where a field code belongs
    'role:owner:0019', // not a field ident
    'role:owner:001900',
    'role:cashier:00190', // a role outside the vocabulary
    'seat:', // an empty settlement asserts nothing
    'eik:201122335', // the ЕИК itself is never stored, only the fact that one matched
  ])
    assert.equal(MATCHED_FACT_RE.test(bad), false, `wrongly accepted: ${bad}`);

  // null is legal — a rung may match no fact — and that is isSealedFact's job, not the regex's.
  assert.equal(isSealedFact(null), true);
  assert.equal(isSealedFact('seat:ИВАН ПЕТРОВ ГЕОРГИЕВ'), false);
});

test('matched_fact stays inside the closed vocabulary — it can never carry a name', () => {
  for (const v of [
    evidenceVerdict(base),
    evidenceVerdict({ ...base, registry: registry([holder('00070', 'ИВАН ПЕТРОВ ТЕСТОВ')]) }),
    evidenceVerdict({ ...base, declaredEik: true }),
    evidenceVerdict({
      ...base,
      registry: somebodyElse(seatIn('гр. Пловдив')),
      declaredSeats: ['Пловдив'],
    }),
  ]) {
    if (v.matchedFact == null) continue;
    assert.ok(isSealedFact(v.matchedFact), `matched_fact escaped the vocabulary: ${v.matchedFact}`);
    assert.ok(!/ИВАН|ПЕТРОВ|ТЕСТОВ/.test(v.matchedFact), 'a NAME reached matched_fact');
  }
});

test('every verdict carries the rules version that produced it', () => {
  assert.equal(evidenceVerdict(base).rulesVersion, RULES_VERSION);
});

// ── §7 reconciliation ─────────────────────────────────────────────────────────
test('reconcileTermination — still a registered owner ⇒ NOT terminated', () => {
  const r = reconcileTermination({
    registry: OWNER,
    declarantName: 'Иван Петров Тестов',
    scope: 'self',
  });
  assert.equal(r.terminated, false);
  assert.equal(r.label, 'owner_today');
});

test('reconcileTermination — manager only ⇒ terminated as a stake, but the tie continues', () => {
  const mgr = registry([holder('00070', 'ИВАН ПЕТРОВ ТЕСТОВ'), holder('00190', 'ДРУГ')]);
  const r = reconcileTermination({
    registry: mgr,
    declarantName: 'Иван Петров Тестов',
    scope: 'self',
  });
  assert.equal(r.terminated, true);
  assert.equal(r.label, 'manager_today');
});

test('reconcileTermination — registered in no role now ⇒ the declared termination stands', () => {
  const none = registry([holder('00190', 'НЯКОЙ ДРУГ')]);
  const r = reconcileTermination({
    registry: none,
    declarantName: 'Иван Петров Тестов',
    scope: 'self',
  });
  assert.equal(r.terminated, true);
  assert.equal(r.label, null);
});

test('reconcileTermination — a FAMILY stake is never reconciled, by an early branch', () => {
  // Structural, not a caller convention: the relative's name is not stored, so there is nothing to
  // look for, and looking would be a de-anonymisation attempt.
  const r = reconcileTermination({
    registry: OWNER,
    declarantName: 'Иван Петров Тестов',
    scope: 'family',
  });
  assert.equal(r.terminated, true);
  assert.equal(r.label, null);
});

test('a prior ownership fact can use a ended role without manufacturing a declaration window', () => {
  const past = registry([
    holder('00190', base.declarantName, '2010-01-01', {
      removed_on: '2018-01-01',
      subject_id: 'a'.repeat(64),
    }),
  ]);
  const historical = evidenceVerdict({
    ...base,
    registry: past,
    firstDeclaredYear: null,
    historicalDeclaredYear: 2021,
    declaredEik: true,
  });
  assert.equal(historical.kind, 'document');
  assert.notEqual(evidenceVerdict({ ...base, registry: past, declaredEik: true }).kind, 'document');
  assert.notEqual(
    evidenceVerdict({
      ...base,
      registry: past,
      firstDeclaredYear: null,
      historicalDeclaredYear: 2009,
      declaredEik: true,
    }).kind,
    'document',
  );
});
test('same-company Indent follows a changed name, while same-name distinct Idents cannot prove a person', () => {
  const old = holder('00190', base.declarantName, '2010-01-01', {
    removed_on: '2018-01-01',
    subject_id: 'a'.repeat(64),
  });
  const current = holder('00190', 'Иван Петров Тестов-Примеров', '2018-01-01', {
    subject_id: 'a'.repeat(64),
  });
  assert.equal(
    evidenceVerdict({ ...base, registry: registry([old, current]), declaredEik: true }).kind,
    'document',
  );
  const homonym = holder('00190', base.declarantName, '2015-01-01', { subject_id: 'b'.repeat(64) });
  assert.notEqual(
    evidenceVerdict({ ...base, registry: registry([old, current, homonym]), declaredEik: true })
      .kind,
    'document',
  );
});
