// node:test — the libel-critical holder classifier (B4, review #226 / todorkolev 2026-07-30).
// A holder-name cell is classified against the declarant into THREE states, not a byte-equality binary:
//   self    — the cell is the declarant's own name (a permutation / initialed / subset variant of it);
//   related — the cell is CONFIDENTLY a different person (≥2 name components the declarant does not have);
//   unknown — anything else: counted NOWHERE (forms no link, so it never reaches the published surface).
// The old `nameKey(holder)===nameKey(declarant) ? 'self' : 'related'` declared a phantom relative for any
// reordering/initial/subset of the declarant's own name; under ADR-0032 that would publish a fabricated
// „свързано лице" card (a libel risk), so the three-state classifier is the guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHolder } from './parse.mjs';

const DECLARANT = 'Иван Петров Георгиев';

test('classifyHolder — self: exact, empty, reorder, initials, subset (Todor phantom set)', () => {
  // empty holder cell ⇒ the declarant's own stake (source convention)
  assert.equal(classifyHolder('', DECLARANT), 'self');
  assert.equal(classifyHolder('   ', DECLARANT), 'self');
  // exact
  assert.equal(classifyHolder('Иван Петров Георгиев', DECLARANT), 'self');
  // Todor's three empirically-observed phantoms — must be self, not related:
  assert.equal(classifyHolder('Иван Г. Петров', DECLARANT), 'self'); // initial + reorder
  assert.equal(classifyHolder('Георгиев Иван Петров', DECLARANT), 'self'); // full reorder
  assert.equal(classifyHolder('Иван Георгиев', DECLARANT), 'self'); // subset (given+family)
  // case / spacing / diacritic folding must not change the verdict
  assert.equal(classifyHolder('  иван   петров  ГЕОРГИЕВ ', DECLARANT), 'self');
  assert.equal(classifyHolder('Г. П. Иван', DECLARANT), 'self'); // all initials + reorder resolvable
});

test('classifyHolder — related: a confidently different person (≥2 foreign components)', () => {
  // wife: different given + feminine surname form (Георгиева ≠ Георгиев) ⇒ two foreign tokens
  assert.equal(classifyHolder('Мария Георгиева', DECLARANT), 'related');
  assert.equal(classifyHolder('Мария Иванова Георгиева', DECLARANT), 'related');
  // son: different given + patronymic, shares only the family name
  assert.equal(classifyHolder('Стоян Иванов Георгиев', DECLARANT), 'related');
  // wholly unrelated full name
  assert.equal(classifyHolder('Петра Стоянова Димитрова', DECLARANT), 'related');
});

test('classifyHolder — unknown: ambiguous, counted nowhere', () => {
  // exactly one foreign full token — cannot tell self-typo from relative ⇒ unknown
  assert.equal(classifyHolder('Иван Георгиева', DECLARANT), 'unknown'); // fem. surname, else matches
  // a lone token (surname or given only) is insufficient evidence for self
  assert.equal(classifyHolder('Георгиев', DECLARANT), 'unknown');
  assert.equal(classifyHolder('Иван', DECLARANT), 'unknown');
  // a bare initial resolves to nothing decisive
  assert.equal(classifyHolder('Г.', DECLARANT), 'unknown');
  // garbage / non-name
  assert.equal(classifyHolder('—', DECLARANT), 'unknown');
});

test('classifyHolder — an initial never double-consumes one declarant token', () => {
  // holder "И. И." must NOT both match the single declarant "Иван": only one maps, the other is foreign.
  // declarant has one И-token (Иван); "И. И." → one matches Иван, the second И. is unresolved ⇒ not self.
  assert.notEqual(classifyHolder('И. И. И.', DECLARANT), 'self');
});

test('classifyHolder — a missing declarant is unknown, never self/related', () => {
  assert.equal(classifyHolder('Иван Петров Георгиев', ''), 'unknown');
  assert.equal(classifyHolder('Иван Петров Георгиев', '   '), 'unknown');
});
