// node:test — the registry facts of one company (deed.mjs). Pure: rows in, facts out.
//
// What the ladder relies on here: only a natural person standing in a role it reads is a holder, each
// holder is matched on their own, and the legal form withholds whenever neither signal can say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registryFacts,
  liveHolders,
  personTokens,
  fullSubsetMatch,
  normalizeSettlement,
  registrySeat,
  registryLegalForm,
  latestOwnershipEntryDate,
  JOINT_SUFFIX,
  OWNERSHIP_FIELDS,
  MANAGER_FIELD,
  ROLE_FIELDS,
} from './deed.mjs';
import { ROLE_FIELDS as REGISTER_ROLES } from '../../packages/ingest/src/registry-roles.ts';

const deedRow = (over = {}) => ({
  eik: '201122335',
  name: 'АЛФА',
  legal_form: 'OOD',
  seat_settlement: 'гр. Пловдив',
  seat_entry_on: '2015-01-01',
  owners_entry_on: '2016-02-02',
  ...over,
});
const role = (field, name, over = {}) => ({
  field_ident: field,
  subject_kind: 'person',
  subject_name: name,
  entry_number: '20110502101007',
  added_on: '2011-05-02T10:10:07',
  removed_on: null,
  ...over,
});

// ── holders ───────────────────────────────────────────────────────────────────
test('only a natural person standing in a role the ladder reads is a holder', () => {
  const f = registryFacts(deedRow(), [
    role('00190', 'ИВАН ПЕТРОВ ТЕСТОВ'),
    role('00190', 'ГЕОРГИ ДИМИТРОВ ПЕТКОВ', { removed_on: '2019-01-01' }), // ended
    role('00190', 'ХОЛДИНГ АД', { subject_kind: 'entity' }), // a company
    role('00100', 'ПРЕДСТАВИТЕЛ ЕДИН ДРУГ'), // a field the ladder does not read
    role('05500', 'ДЕЙСТВИТЕЛЕН СОБСТВЕНИК ТУК'), // an actual owner
    role('00070', 'МАРИЯ СТОЯНОВА ИВАНОВА'),
  ]);
  assert.deepEqual(
    f.holders.map((h) => [h.field, h.name]),
    [
      ['00070', 'МАРИЯ СТОЯНОВА ИВАНОВА'],
      ['00190', 'ИВАН ПЕТРОВ ТЕСТОВ'],
    ],
  );
  assert.deepEqual(f.holders[1], {
    field: '00190',
    name: 'ИВАН ПЕТРОВ ТЕСТОВ',
    entryNumber: '20110502101007',
    entryDate: '2011-05-02',
  });
});

test('the holders come in one order, whatever order the rows came in', () => {
  const rows = [role('00190', 'Б'), role('00190', 'А'), role('00070', 'В')];
  assert.deepEqual(
    registryFacts(deedRow(), rows).holders,
    registryFacts(deedRow(), [...rows].reverse()).holders,
  );
});

test('an entry number stays text', () => {
  const f = registryFacts(deedRow(), [
    role('00190', 'ИВАН ПЕТРОВ ТЕСТОВ', { entry_number: 20130716101007 }),
  ]);
  assert.equal(f.holders[0].entryNumber, '20130716101007');
});

test('liveHolders keeps only the requested fields', () => {
  const f = registryFacts(deedRow(), [role('00190', 'А Б В'), role('00070', 'Г Д Е')]);
  assert.deepEqual(
    liveHolders(f, [MANAGER_FIELD]).map((h) => h.name),
    ['Г Д Е'],
  );
  assert.deepEqual(
    liveHolders(f, OWNERSHIP_FIELDS).map((h) => h.name),
    ['А Б В'],
  );
  assert.deepEqual(liveHolders(null, ROLE_FIELDS), []);
});

test('the fields the ladder reads are the register’s manager field and every ownership field', () => {
  assert.equal(REGISTER_ROLES[MANAGER_FIELD], 'manager');
  const ownership = ['partner', 'sole_owner', 'trader'];
  for (const f of OWNERSHIP_FIELDS) assert.ok(ownership.includes(REGISTER_ROLES[f]), f);
  // …and no ownership field the register records is left out.
  for (const [f, r] of Object.entries(REGISTER_ROLES))
    if (ownership.includes(r)) assert.ok(OWNERSHIP_FIELDS.includes(f), f);
});

// ── names ─────────────────────────────────────────────────────────────────────
test('personTokens keeps tokens of length ≥2 and folds case and spacing', () => {
  assert.deepEqual(personTokens('  иван   ПЕТРОВ-тестов '), ['ИВАН', 'ПЕТРОВ', 'ТЕСТОВ']);
  assert.deepEqual(personTokens('Г. И. Петров'), ['ПЕТРОВ'], 'initials never count as names');
  assert.deepEqual(personTokens(null), []);
});

test('fullSubsetMatch requires EVERY declarant token, not a majority', () => {
  assert.equal(fullSubsetMatch('Иван Петров Тестов', 'ИВАН ПЕТРОВ ТЕСТОВ'), true);
  assert.equal(fullSubsetMatch('Иван Петров Тестов', 'ИВАН ПЕТРОВ ДРУГОВ'), false);
  assert.equal(fullSubsetMatch('', 'ИВАН ПЕТРОВ ТЕСТОВ'), false, 'an empty name matches nothing');
});

test('a token must match a WHOLE token, never a substring', () => {
  assert.equal(fullSubsetMatch('Иван Петров Тестов', 'ИВАН ПЕТРОВА ТЕСТОВ'), false);
});

// ── seat ──────────────────────────────────────────────────────────────────────
test('T5 — the settlement prefix is stripped only as a whole token', () => {
  assert.equal(normalizeSettlement('гр. София'), 'СОФИЯ');
  assert.equal(normalizeSettlement('гр.София'), 'СОФИЯ');
  assert.equal(normalizeSettlement('София'), 'СОФИЯ', 'СОФИЯ never becomes ОФИЯ');
  assert.equal(normalizeSettlement('Градец'), 'ГРАДЕЦ', 'ГРАДЕЦ never becomes АДЕЦ');
  assert.equal(normalizeSettlement('с. Марково, п.к. 4108'), 'МАРКОВО');
  assert.equal(normalizeSettlement('София (столица)'), 'СОФИЯ');
});

test('T5 — an empty settlement normalises to empty, which never confirms anything', () => {
  assert.equal(normalizeSettlement(''), '');
  assert.equal(normalizeSettlement(null), '');
});

test('registrySeat normalises the settlement and keeps the day the seat was registered', () => {
  assert.deepEqual(registrySeat(registryFacts(deedRow(), [])), {
    settlement: 'ПЛОВДИВ',
    entryDate: '2015-01-01',
  });
  assert.deepEqual(
    registrySeat(registryFacts(deedRow({ seat_settlement: null, seat_entry_on: null }), [])),
    { settlement: '', entryDate: null },
  );
});

// ── legal form ────────────────────────────────────────────────────────────────
const form = (legal_form, name) =>
  registryLegalForm(registryFacts(deedRow({ legal_form, name }), [])).verdict;

test('T3 — the legal-form verdict is a UNION of the register’s code and the ЗТРРЮЛНЦ suffix', () => {
  assert.equal(form('AD', 'ГАМА'), 'joint_stock');
  assert.equal(form('OOD', '"ГАМА" АД'), 'joint_stock', 'the suffix alone bars');
  assert.equal(form(null, '"ГАМА" ЕАД'), 'joint_stock');
  assert.equal(form('EOOD', 'ГАМА'), 'closely_held');
  assert.equal(form('K', 'ПАНДА'), 'closely_held');
  assert.equal(form(null, '"ГАМА" ООД'), 'closely_held');
});

test('T3 — neither signal able to say withholds', () => {
  assert.equal(form('XYZ', 'НЕЩО'), 'unknown', 'an unknown code withholds');
  assert.equal(form(null, 'НЕЩО'), 'unknown');
});

test('T3 — КДА and АДСИЦ are barred, and the code is read whatever its case and spacing', () => {
  assert.equal(form('KDA', 'Х'), 'joint_stock');
  assert.equal(form('ADSITS', 'Х'), 'joint_stock');
  assert.equal(form(null, '"Х" КДА'), 'joint_stock');
  assert.equal(form(' ead ', 'Х'), 'joint_stock');
});

// ── refutation input ──────────────────────────────────────────────────────────
test('latestOwnershipEntryDate is the day the registry layer dated the ownership record', () => {
  assert.equal(latestOwnershipEntryDate(registryFacts(deedRow(), [])), '2016-02-02');
  assert.equal(
    latestOwnershipEntryDate(registryFacts(deedRow({ owners_entry_on: null }), [])),
    null,
  );
});

// ── the twin rule ─────────────────────────────────────────────────────────────
// JOINT_SUFFIX here and JOINT_STOCK in scripts/cacbg/classify.mjs are the SAME rule — which legal forms
// are joint-stock — kept as twins so the two directories do not import each other. A prose „keep these in
// step" note is exactly how they drifted once; this test is what keeps them in step.
test('the joint-stock suffix rule is identical in the registry facts and the classifier', async () => {
  const { JOINT_STOCK } = await import('../cacbg/classify.mjs');
  assert.equal(JOINT_SUFFIX.source, JOINT_STOCK.source, 'the two patterns have diverged');
  assert.equal(JOINT_SUFFIX.flags, JOINT_STOCK.flags, 'the two patterns have diverged in flags');
  for (const name of ['"ГАМА" АД', 'ГАМА ЕАД', '"ГАМА" КДА', 'ГАМА АДСИЦ'])
    assert.equal(JOINT_SUFFIX.test(name), true, name);
  for (const name of ['"ГАМА" ООД', 'АДАМ ЕООД', 'ГАМА'])
    assert.equal(JOINT_SUFFIX.test(name), false, name);
});
