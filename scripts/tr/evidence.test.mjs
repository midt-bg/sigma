// node:test — the evidence ladder (ADR-0033 decision 1). Pure: deed in, verdict out.
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

const container = (t) =>
  `<div class='record-container record-container--preview'><p class='field-text'>${t}</p></div>`;
const joined = (...ts) => ts.map(container).join(`<hr class='hr--report' />`);
const ERASED = `<div class='record-container'><div class='erasure-text-inline'>Заличено обстоятелство.</div></div>`;

const fld = (nameCode, htmlData, entryDate = '2011-05-02T00:00:00') => ({
  nameCode,
  htmlData,
  fieldEntryNumber: '20110502101007',
  fieldEntryDate: entryDate,
  fieldOperation: 3,
});
const deed = (fields, over = {}) => ({
  uic: '201122335',
  fullName: '"АЛФА СТРОЙ" ООД',
  legalForm: 4,
  sections: [{ subDeeds: [{ groups: [{ fields }] }] }],
  ...over,
});

const OWNER_DEED = deed([
  fld('CR_F_19_L', joined('ИВАН ПЕТРОВ ТЕСТОВ, Държава: БЪЛГАРИЯ', 'МАРИЯ СТОЯНОВА ИВАНОВА')),
  fld('CR_F_5_L', container('Държава: БЪЛГАРИЯ<br/>Населено място: гр. Пловдив, п.к. 4000')),
]);

const base = {
  deed: OWNER_DEED,
  declarantName: 'Иван Петров Тестов',
  declaredSeats: [],
  declaredEik: false,
  firstDeclaredYear: 2021,
  scope: 'self',
  nameGloballyUnique: true,
  // The company was resolved by a name unlikely to have a national twin. The rung-2 tests below are about
  // NAME matching inside a deed, so they hold this dimension fixed; the gate itself is tested separately.
  companyNameDistinctive: true,
};

test('RULES_VERSION is a stable, non-empty identifier — §8 hangs off it', () => {
  assert.equal(typeof RULES_VERSION, 'string');
  assert.ok(RULES_VERSION.length > 0);
});

// ── rung 1: the joint-stock bar wins over everything ──────────────────────────
test('rung 1 — a joint-stock company is barred even when the person IS in the deed', () => {
  const ad = deed([fld('CR_F_19_L', container('ИВАН ПЕТРОВ ТЕСТОВ'))], {
    legalForm: 5,
    fullName: '"ГАМА ИНВЕСТ" АД',
  });
  const v = evidenceVerdict({ ...base, deed: ad });
  assert.equal(v.kind, 'bar_joint_stock');
  assert.equal(v.publishable, false);
});

test('rung 1 — an UNKNOWN legal form withholds; it never falls through to a lower rung', () => {
  const odd = deed([fld('CR_F_19_L', container('ИВАН ПЕТРОВ ТЕСТОВ'))], {
    legalForm: 99,
    fullName: 'НЕЩО БЕЗ ФОРМА',
  });
  const v = evidenceVerdict({ ...base, deed: odd });
  assert.equal(v.kind, 'unknown');
  assert.equal(v.publishable, false);
});

// ── rung 2: „Документ" ────────────────────────────────────────────────────────
test('rung 2 — a full-name match in a live ownership field publishes, with the role kept', () => {
  const v = evidenceVerdict(base);
  assert.equal(v.kind, 'document');
  assert.equal(v.publishable, true);
  assert.equal(v.registryRole, 'owner');
  assert.equal(v.matchedFact, 'role:owner:CR_F_19_L');
  assert.equal(v.entryNumber, '20110502101007');
  assert.equal(v.entryDate, '2011-05-02');
});

test('rung 2 — a manager-only match publishes but records the weaker role', () => {
  const mgr = deed([
    fld('CR_F_7_L', container('ИВАН ПЕТРОВ ТЕСТОВ, Държава: БЪЛГАРИЯ')),
    fld('CR_F_19_L', container('ДРУГО ЛИЦЕ ТУК')),
  ]);
  const v = evidenceVerdict({ ...base, deed: mgr });
  assert.equal(v.kind, 'document');
  assert.equal(v.registryRole, 'manager');
  assert.equal(v.matchedFact, 'role:manager:CR_F_7_L');
});

test('rung 2 — a TWO-token declarant can never earn „Документ"', () => {
  // 46 of 301 measured matches were two-token only, which is exactly the homonym risk. Falls to a
  // lower rung rather than publishing on a name that half a register could satisfy.
  const two = deed([fld('CR_F_19_L', container('ИВАН ТЕСТОВ, Държава: БЪЛГАРИЯ'))]);
  const v = evidenceVerdict({ ...base, deed: two, declarantName: 'Иван Тестов' });
  assert.notEqual(v.kind, 'document');
  assert.equal(v.shortName, true, 'the refusal is counted, not silently dropped');
});

test('rung 2 — the match must fall inside ONE entity (the libel guard, end to end)', () => {
  const two = deed([
    fld('CR_F_19_L', joined('ПЕНКО НЕСТОРОВ НЕСТОРОВ', 'ИЛИЯН КОСТАДИНОВ ФИЛИПОВ')),
  ]);
  const v = evidenceVerdict({ ...base, deed: two, declarantName: 'ПЕНКО КОСТАДИНОВ ФИЛИПОВ' });
  assert.notEqual(v.kind, 'document');
});

test('rung 2 — an ERASED ownership entry cannot produce a document match', () => {
  const gone = deed([fld('CR_F_23_L', ERASED, '2013-07-16T10:10:07')]);
  const v = evidenceVerdict({ ...base, deed: gone });
  assert.notEqual(v.kind, 'document');
});

test('rung 2 — a Latin homoglyph in the name is a NON-match, and is counted', () => {
  // company-name-key.ts deliberately does not fold Cyrillic↔Latin; person names take the same posture.
  const v = evidenceVerdict({ ...base, declarantName: 'ИBAH ПЕТРОВ ТЕСТОВ' }); // Latin B, A, H
  assert.notEqual(v.kind, 'document');
  assert.equal(v.latinInName, true);
});

// ── rung 3: „Потвърдено" ──────────────────────────────────────────────────────
test('rung 3 — a declared seat matching the registered seat confirms the company', () => {
  const other = deed([
    fld('CR_F_19_L', container('НЯКОЙ ДРУГ ЧОВЕК')),
    fld('CR_F_5_L', container('Населено място: гр. Пловдив, п.к. 4000'), '2015-01-01T00:00:00'),
  ]);
  const v = evidenceVerdict({ ...base, deed: other, declaredSeats: ['Пловдив'] });
  assert.equal(v.kind, 'confirmed');
  assert.equal(v.publishable, true);
  assert.equal(v.matchedFact, 'seat:ПЛОВДИВ');
});

test('rung 3 — a declared ЕИК confirms the company on its own', () => {
  const other = deed([fld('CR_F_19_L', container('НЯКОЙ ДРУГ ЧОВЕК'))]);
  const v = evidenceVerdict({ ...base, deed: other, declaredEik: true });
  assert.equal(v.kind, 'confirmed');
  assert.equal(v.matchedFact, 'eik');
});

test('rung 3 — an EMPTY declared seat never confirms', () => {
  const noSeat = deed([fld('CR_F_19_L', container('НЯКОЙ ДРУГ ЧОВЕК'))]);
  const v = evidenceVerdict({ ...base, deed: noSeat, declaredSeats: ['', '   '] });
  assert.notEqual(v.kind, 'confirmed');
});

test('rung 3 — a seat registered AFTER the declared period does not confirm', () => {
  // R10, and W0 measured that seats move: a company that relocated INTO the declared settlement after
  // the fact would otherwise produce a false „Потвърдено".
  const moved = deed([
    fld('CR_F_19_L', container('НЯКОЙ ДРУГ ЧОВЕК')),
    fld('CR_F_5_L', container('Населено място: гр. Пловдив'), '2024-06-01T00:00:00'),
  ]);
  const v = evidenceVerdict({
    ...base,
    deed: moved,
    declaredSeats: ['Пловдив'],
    firstDeclaredYear: 2021,
  });
  assert.notEqual(v.kind, 'confirmed');
});

test('rung 3 — an UNKNOWN first declared year cannot confirm on a seat', () => {
  // R10 again, from the other side. `load.mjs` passes `firstDeclaredYear: null` whenever no history row
  // carried a parseable year, and a null year means the temporal check has NOTHING to compare against —
  // not that the seat covers the period. The same relocated company as the test above, with the year
  // unknown instead of 2021, must reach the same held outcome: an unknown guard is a failed guard.
  const moved = deed([
    fld('CR_F_19_L', container('НЯКОЙ ДРУГ ЧОВЕК')),
    fld('CR_F_5_L', container('Населено място: гр. Пловдив'), '2024-06-01T00:00:00'),
  ]);
  const v = evidenceVerdict({
    ...base,
    deed: moved,
    declaredSeats: ['Пловдив'],
    firstDeclaredYear: null,
  });
  assert.notEqual(v.kind, 'confirmed');
});

test('rung 3 — an unknown year holds a seat match even when the seat has NO entry date', () => {
  // The nastier half: with no entry date on the register side AND no year on the declaration side there
  // are two unknowns and zero evidence about the period, yet both legs of the old disjunction read TRUE.
  // Rung 4's refutation leg already refuses to run without a year (`firstDeclaredYear != null`); the seat
  // leg must refuse on the same ground, or the weakest rung is the one with no temporal check at all.
  const undated = deed([
    fld('CR_F_19_L', container('НЯКОЙ ДРУГ ЧОВЕК')),
    fld('CR_F_5_L', container('Населено място: гр. Пловдив')),
  ]);
  const v = evidenceVerdict({
    ...base,
    deed: undated,
    declaredSeats: ['Пловдив'],
    firstDeclaredYear: null,
  });
  assert.notEqual(v.kind, 'confirmed', 'two unknowns must not multiply into a public claim');
});

test('rung 3 — a KNOWN year with an undated seat still confirms (the guard is not a blanket)', () => {
  // Positive control. Bounding the null case must not quietly kill the rung: a seat with no entry date
  // is the ordinary shape for a company that never moved, and it still confirms under a known year.
  const undated = deed([
    fld('CR_F_19_L', container('НЯКОЙ ДРУГ ЧОВЕК')),
    fld('CR_F_5_L', container('Населено място: гр. Пловдив')),
  ]);
  const v = evidenceVerdict({
    ...base,
    deed: undated,
    declaredSeats: ['Пловдив'],
    firstDeclaredYear: 2021,
  });
  assert.equal(v.kind, 'confirmed');
  assert.equal(v.matchedFact, 'seat:ПЛОВДИВ');
});

test('rung 3 — the weakest rung ALSO requires global name uniqueness (ADR-0017 carried forward)', () => {
  const other = deed([
    fld('CR_F_19_L', container('НЯКОЙ ДРУГ ЧОВЕК')),
    fld('CR_F_5_L', container('Населено място: гр. Пловдив')),
  ]);
  const v = evidenceVerdict({
    ...base,
    deed: other,
    declaredSeats: ['Пловдив'],
    nameGloballyUnique: false,
  });
  assert.notEqual(v.kind, 'confirmed', 'a nationally shared name cannot ride the weakest rung');
});

test('rung 3 — a declared ЕИК is NOT gated by name uniqueness (ADR-0028)', () => {
  // The case ADR-0017 was written about — a фирма backing two ЕИК — is exactly where a declarant-supplied
  // ЕИК is most valuable. Gating it on the name would discard the strongest identifier precisely when the
  // name is useless.
  const other = deed([fld('CR_F_19_L', container('НЯКОЙ ДРУГ ЧОВЕК'))]);
  const v = evidenceVerdict({
    ...base,
    deed: other,
    declaredEik: true,
    nameGloballyUnique: false,
  });
  assert.equal(v.kind, 'confirmed');
  assert.equal(v.matchedFact, 'eik');
});

test('rung 3 — the seat rung DOES rescue a merely generic name; it is uniqueness that gates it', () => {
  // The seat leg exists to rescue generic names (a bare one- or two-word фирма). Requiring the name to
  // be distinctive would empty the rung of its entire purpose; only NATIONAL non-uniqueness blocks it.
  const generic = deed([
    fld('CR_F_19_L', container('НЯКОЙ ДРУГ ЧОВЕК')),
    fld('CR_F_5_L', container('Населено място: гр. Пловдив')),
  ]);
  const v = evidenceVerdict({
    ...base,
    deed: generic,
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

test('rung 2 — every OWNERSHIP field code can carry the match, not just CR_F_19_L', () => {
  // OWNERSHIP_FIELDS is ['CR_F_18_L','CR_F_19_L','CR_F_23_L'] — едноличен собственик, съдружници, and
  // ФЛ-търговец. Every owner test used CR_F_19_L, so a typo or a dropped entry in the other two would
  // have silently withheld an entire ownership shape: a sole owner (the commonest ЕООД form) publishing
  // as „Неизвестна" is a recall hole with no symptom.
  for (const code of ['CR_F_18_L', 'CR_F_19_L', 'CR_F_23_L']) {
    const d = deed([fld(code, container('ИВАН ПЕТРОВ ТЕСТОВ'))]);
    const v = evidenceVerdict({ ...base, deed: d });
    assert.equal(v.kind, 'document', `${code} must carry an ownership match`);
    assert.equal(v.registryRole, 'owner', `${code} is an OWNERSHIP field, not management`);
    assert.equal(v.matchedFact, `role:owner:${code}`);
  }
  // POSITIVE CONTROL — a field that is NOT an ownership or manager field must not match at all, or the
  // loop above would pass for a reason other than the one it claims.
  const other = deed([fld('CR_F_99_L', container('ИВАН ПЕТРОВ ТЕСТОВ'))]);
  assert.notEqual(evidenceVerdict({ ...base, deed: other }).kind, 'document');
});

// ── rung 2's company gate: the winner-vs-non-winner homonym (ADR-0035) ────────
//
// The ladder proves a person with these three tokens is registered in the company we LOOKED UP. It cannot
// prove that company is the one the official declared. `resolveEntity` maps a declared name to the sole
// WINNER holding it, and `nameGloballyUnique` ranges over procurement bidders only — never the whole
// register. So when an official owns a same-named company that never bid, we resolve to the winner, and a
// three-token homonym in the winner's deed „proves" a link that is false in both halves.
//
// Two coincidences, and neither is rare in Bulgaria: a shared фирма and a shared three-part name. The gate
// asks for a reason to believe the COMPANY is the declared one before rung 2 may assert.
test('rung 2 — a GENERIC company name with no corroboration cannot publish on a name match alone', () => {
  const v = evidenceVerdict({ ...base, companyNameDistinctive: false });
  assert.equal(
    v.kind,
    'document_uncorroborated',
    'the deed names SOMEONE with this name in THIS company — not that this is the declared company',
  );
  assert.equal(v.publishable, false);
  // It must not fall through to `unknown`: the residual is the input to F8's decision on whether this gate
  // tightens, and a rung-2 match withheld for want of company identity is a different fact from no match.
  assert.equal(v.registryRole, null);
  assert.equal(v.matchedFact, null);
});

test('rung 2 — a declared ЕИК corroborates the company, so the name match publishes', () => {
  // POSITIVE CONTROL. The ЕИК IS the identity (ЗТРРЮЛНЦ, ADR-0028) — it resolves the company behind any
  // shared фирма, which is exactly the collision the gate is about.
  const v = evidenceVerdict({ ...base, companyNameDistinctive: false, declaredEik: true });
  assert.equal(v.kind, 'document');
  assert.equal(v.publishable, true);
  assert.equal(v.registryRole, 'owner');
});

test('rung 2 — a declared seat matching the registered seat corroborates the company', () => {
  // POSITIVE CONTROL. The declarant put this company in гр. Пловдив and the register agrees; a national
  // twin in another town is excluded by the same fact rung 3 publishes on.
  const v = evidenceVerdict({
    ...base,
    companyNameDistinctive: false,
    declaredSeats: ['гр. Пловдив'],
  });
  assert.equal(v.kind, 'document');
  assert.equal(v.publishable, true);
});

test('rung 2 — a DISTINCTIVE company name publishes uncorroborated (the gate is not a blanket)', () => {
  // POSITIVE CONTROL, and the one that distinguishes this fix from disabling rung 2. A predicate that
  // always withheld would satisfy the bar above; this is what it must NOT do.
  const v = evidenceVerdict({ ...base, companyNameDistinctive: true });
  assert.equal(v.kind, 'document');
  assert.equal(v.publishable, true);
});

test('rung 2 — a seat that does NOT match cannot corroborate a generic name', () => {
  // The corroborator has to actually corroborate. A declared seat in another town is evidence AGAINST the
  // company being the declared one, so it certainly cannot rescue the rung.
  const v = evidenceVerdict({
    ...base,
    companyNameDistinctive: false,
    declaredSeats: ['гр. Бургас'], // the deed says Пловдив
  });
  assert.equal(v.kind, 'document_uncorroborated');
  assert.equal(v.publishable, false);
});

test('rung 2 — the seat corroborator carries the SAME temporal guard as rung 3 (R10)', () => {
  // A seat registered after the declared period cannot corroborate anything: the company may have moved
  // INTO that town afterwards. Rung 3 already refuses it; rungs 2 and 3 share one implementation so they
  // cannot drift into disagreeing about what a seat match means.
  const moved = deed([
    fld('CR_F_19_L', container('ИВАН ПЕТРОВ ТЕСТОВ')),
    fld(
      'CR_F_5_L',
      container('Държава: БЪЛГАРИЯ<br/>Населено място: гр. Пловдив, п.к. 4000'),
      '2023-07-01T00:00:00',
    ),
  ]);
  const v = evidenceVerdict({
    ...base,
    deed: moved,
    companyNameDistinctive: false,
    declaredSeats: ['гр. Пловдив'],
    firstDeclaredYear: 2021,
  });
  assert.equal(v.kind, 'document_uncorroborated');
});

test('rung 2 — the company gate never rescues a link rung 1 has barred', () => {
  // Ordering: a joint-stock bar outranks everything, corroborated or not. The gate adds a way to WITHHOLD,
  // never a way to publish something a stronger rung refused.
  const ad = deed([fld('CR_F_19_L', container('ИВАН ПЕТРОВ ТЕСТОВ'))], {
    legalForm: 5,
    fullName: '"ГАМА ИНВЕСТ" АД',
  });
  const v = evidenceVerdict({ ...base, deed: ad, companyNameDistinctive: true, declaredEik: true });
  assert.equal(v.kind, 'bar_joint_stock');
});

// ── rung 4: „Оборена" ─────────────────────────────────────────────────────────
test('rung 4 — absent from a deed whose ownership predates the declaration refutes the link', () => {
  const older = deed([
    fld('CR_F_19_L', container('СЪВСЕМ ДРУГ СОБСТВЕНИК'), '2015-03-01T00:00:00'),
  ]);
  const v = evidenceVerdict({ ...base, deed: older, firstDeclaredYear: 2021 });
  assert.equal(v.kind, 'refuted');
  assert.equal(v.publishable, false);
});

test('rung 4 — the comparison is date-to-DATE, not date-to-year', () => {
  // R17: „strictly before the first declared year" means before YYYY-01-01. An entry inside the first
  // declared year does NOT cover the period and must not refute.
  const inYear = deed([fld('CR_F_19_L', container('ДРУГ СОБСТВЕНИК'), '2021-06-15T00:00:00')]);
  assert.notEqual(
    evidenceVerdict({ ...base, deed: inYear, firstDeclaredYear: 2021 }).kind,
    'refuted',
  );
  const justBefore = deed([fld('CR_F_19_L', container('ДРУГ СОБСТВЕНИК'), '2020-12-31T00:00:00')]);
  assert.equal(
    evidenceVerdict({ ...base, deed: justBefore, firstDeclaredYear: 2021 }).kind,
    'refuted',
  );
});

test('rung 4 — NEVER applies to a family stake', () => {
  // The owner there is the relative, whose name we neither store nor check (ADR-0010 item 4,
  // ADR-0032 decision 2), so „the official is not in the deed" says nothing at all.
  const older = deed([fld('CR_F_19_L', container('ДРУГ СОБСТВЕНИК'), '2015-03-01T00:00:00')]);
  const v = evidenceVerdict({ ...base, deed: older, scope: 'family', firstDeclaredYear: 2021 });
  assert.notEqual(v.kind, 'refuted');
  assert.equal(v.kind, 'unknown');
});

test('rung 4 — suppressed inside the 2011–2012 re-registration window', () => {
  // R13: court-registered companies had every entry date flattened into the re-registration window,
  // so „strictly before" certifies nothing there.
  const flattened = deed([fld('CR_F_19_L', container('ДРУГ СОБСТВЕНИК'), '2011-11-04T00:00:00')]);
  const v = evidenceVerdict({ ...base, deed: flattened, firstDeclaredYear: 2021 });
  assert.notEqual(v.kind, 'refuted');
  assert.equal(v.kind, 'unknown');
});

// ── rungs 5 and 6 ─────────────────────────────────────────────────────────────
test('rung 5 — everything else is „Неизвестна" and stays hidden', () => {
  const recent = deed([fld('CR_F_19_L', container('ДРУГ СОБСТВЕНИК'), '2023-01-01T00:00:00')]);
  const v = evidenceVerdict({ ...base, deed: recent, firstDeclaredYear: 2021 });
  assert.equal(v.kind, 'unknown');
  assert.equal(v.publishable, false);
});

test('rung 6 — outside the register is its own outcome, and is not publishable', () => {
  const v = evidenceVerdict({ ...base, deed: null, outsideTr: true });
  assert.equal(v.kind, 'outside_tr');
  assert.equal(v.publishable, false);
});

test('a missing deed that is NOT marked outside-ТР is an error, not a silent hold', () => {
  // Fail closed: a cache gap must be visible, never quietly downgraded to „unknown".
  assert.throws(() => evidenceVerdict({ ...base, deed: null, outsideTr: false }), /deed/i);
});

// ── the seal ──────────────────────────────────────────────────────────────────
test('MATCHED_FACT_RE bounds a settlement to two tokens — a NAME cannot wear the seat: prefix', () => {
  // The rail tested DIRECTLY, not just through whatever verdicts the ladder happens to produce. Both
  // seal tests previously restated this regex locally and got it WRONG in the permissive direction —
  // `seat:` followed by unlimited uppercase tokens — so a three-part Bulgarian name (ЗГР чл. 9) wearing
  // an allowed prefix passed them. That value is exactly what a mis-split of the seat field produces,
  // and it is the one shape this rail exists to keep off a served column.
  for (const ok of [
    'seat:СОФИЯ',
    'seat:ВЕЛИКО ТЪРНОВО', // a real two-token settlement must still pass
    'seat:ГЕНЕРАЛ ТОШЕВО',
    'seat:ЦАР-КАЛОЯН', // hyphenated is one token
    'role:owner:CR_F_19_L',
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
    'role:cashier:CR_F_19_L', // a role outside the vocabulary
    'seat:', // an empty settlement asserts nothing
    'eik:201122335', // the ЕИК itself is never stored, only the fact that one matched
  ])
    assert.equal(MATCHED_FACT_RE.test(bad), false, `wrongly accepted: ${bad}`);

  // null is legal — a rung may match no fact — and that is isSealedFact's job, not the regex's.
  assert.equal(isSealedFact(null), true);
  assert.equal(isSealedFact('seat:ИВАН ПЕТРОВ ГЕОРГИЕВ'), false);
});

test('matched_fact stays inside the closed vocabulary — it can never carry a name', () => {
  // The PRODUCTION predicate, imported — never a local copy of it. A re-stated regex here was looser
  // than `MATCHED_FACT_RE` (it allowed `seat:` + unlimited tokens), so this loop certified values the
  // real rail rejects and could not fail on the regression it exists to catch (cefothe, #309).
  for (const v of [
    evidenceVerdict(base),
    evidenceVerdict({ ...base, deed: deed([fld('CR_F_7_L', container('ИВАН ПЕТРОВ ТЕСТОВ'))]) }),
    evidenceVerdict({ ...base, declaredEik: true }),
    evidenceVerdict({
      ...base,
      deed: deed([
        fld('CR_F_19_L', container('ДРУГ ЧОВЕК')),
        fld('CR_F_5_L', container('Населено място: гр. Пловдив')),
      ]),
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
    deed: OWNER_DEED,
    declarantName: 'Иван Петров Тестов',
    scope: 'self',
  });
  assert.equal(r.terminated, false);
  assert.equal(r.label, 'owner_today');
});

test('reconcileTermination — manager only ⇒ terminated as a stake, but the tie continues', () => {
  const mgr = deed([
    fld('CR_F_7_L', container('ИВАН ПЕТРОВ ТЕСТОВ')),
    fld('CR_F_19_L', container('ДРУГ')),
  ]);
  const r = reconcileTermination({ deed: mgr, declarantName: 'Иван Петров Тестов', scope: 'self' });
  assert.equal(r.terminated, true);
  assert.equal(r.label, 'manager_today');
});

test('reconcileTermination — absent from the live deed ⇒ the declared termination stands', () => {
  const none = deed([fld('CR_F_19_L', container('НЯКОЙ ДРУГ'))]);
  const r = reconcileTermination({
    deed: none,
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
    deed: OWNER_DEED,
    declarantName: 'Иван Петров Тестов',
    scope: 'family',
  });
  assert.equal(r.terminated, true);
  assert.equal(r.label, null);
});
